require('dotenv').config();
const express = require('express');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const redis = require('redis');
const app = express();
const port = process.env.PORT || 3000;

// Import AWS SDK clients
const { EC2Client, DescribeRegionsCommand, DescribeInstancesCommand, DescribeVolumesCommand } = require('@aws-sdk/client-ec2');
const { S3Client, ListBucketsCommand, GetBucketLocationCommand } = require('@aws-sdk/client-s3');
const { RDSClient, DescribeDBInstancesCommand } = require('@aws-sdk/client-rds');
const { LambdaClient, ListFunctionsCommand } = require('@aws-sdk/client-lambda');
const { CloudWatchClient, GetMetricDataCommand } = require('@aws-sdk/client-cloudwatch');
const { PricingClient, GetProductsCommand } = require('@aws-sdk/client-pricing');

// Initialize Redis client
const redisClient = redis.createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
  password: process.env.REDIS_PASSWORD || undefined
});

redisClient.on('error', (err) => console.error('Redis Client Error:', err));
redisClient.on('connect', () => console.log('Redis Client Connected'));

// Connect to Redis
(async () => {
  await redisClient.connect();
})();

// Cache configuration
const CACHE_TTL = {
  RESOURCES: 300, // 5 minutes for resources
  REGIONS: 86400, // 24 hours for regions (rarely changes)
  PRICING: 86400, // 24 hours for pricing data
  METRICS: 300, // 5 minutes for CloudWatch metrics
};

// Cache helper functions
async function getCached(key) {
  try {
    const data = await redisClient.get(key);
    return data ? JSON.parse(data) : null;
  } catch (err) {
    console.error('Redis get error:', err);
    return null;
  }
}

async function setCached(key, data, ttl = CACHE_TTL.RESOURCES) {
  try {
    await redisClient.setEx(key, ttl, JSON.stringify(data));
  } catch (err) {
    console.error('Redis set error:', err);
  }
}

async function clearCache(pattern) {
  try {
    const keys = await redisClient.keys(pattern);
    if (keys.length > 0) {
      await redisClient.del(keys);
      console.log(`Cleared ${keys.length} cache keys matching ${pattern}`);
    }
  } catch (err) {
    console.error('Redis clear cache error:', err);
  }
}

// Shared credentials from env
const credentials = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
};

if (!credentials.accessKeyId || !credentials.secretAccessKey) {
  console.error('AWS credentials not set in .env');
  process.exit(1);
}

// Configure nodemailer for Gmail SMTP
const emailUser = process.env.EMAIL_USER;
const emailPass = process.env.EMAIL_PASS;
const receiverEmail = process.env.RECEIVER_EMAIL;
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: emailUser,
    pass: emailPass
  }
});

if (!emailUser || !emailPass || !receiverEmail) {
  console.warn('Email configuration not set in .env');
}

// Store last scanned unused resources
let lastUnusedResources = [];

// Map regions to Pricing API location names
const regionToLocation = {
  'us-east-1': 'US East (N. Virginia)',
  'us-east-2': 'US East (Ohio)',
  'us-west-1': 'US West (N. California)',
  'us-west-2': 'US West (Oregon)',
  'eu-west-1': 'EU (Ireland)',
  'eu-west-2': 'EU (London)',
  'eu-central-1': 'EU (Frankfurt)',
  'ap-northeast-1': 'Asia Pacific (Tokyo)',
  'ap-southeast-1': 'Asia Pacific (Singapore)',
  'ap-southeast-2': 'Asia Pacific (Sydney)'
};

// Helper to paginate AWS describe calls
async function paginateDescribe(client, CommandClass, params, resultKey) {
  let results = [];
  let nextToken;
  do {
    const command = new CommandClass({ ...params, NextToken: nextToken });
    const data = await client.send(command).catch(err => { throw err; });
    if (data[resultKey]) results = results.concat(data[resultKey]);
    nextToken = data.NextToken || data.Marker;
  } while (nextToken);
  return results;
}

// Helper to get metric from CloudWatch (with caching)
async function getMetric(cwClient, namespace, metricName, dimensions, stat = 'Average', days = 1) {
  // Create a cache key for the metric
  const cacheKey = `metric:${namespace}:${metricName}:${JSON.stringify(dimensions)}:${stat}:${days}`;
  
  // Try to get from cache first
  const cachedMetric = await getCached(cacheKey);
  if (cachedMetric !== null) {
    return cachedMetric;
  }
  
  const period = days <= 1 ? 3600 : 86400;
  const params = {
    StartTime: new Date(Date.now() - days * 24 * 60 * 60 * 1000),
    EndTime: new Date(),
    MetricDataQueries: [{
      Id: 'm1',
      MetricStat: {
        Metric: { Namespace: namespace, MetricName: metricName, Dimensions: dimensions },
        Period: period,
        Stat: stat
      }
    }]
  };
  
  const data = await cwClient.send(new GetMetricDataCommand(params));
  const values = data.MetricDataResults[0].Values || [];
  let result;
  
  if (stat === 'Sum') {
    result = values.reduce((a, b) => a + b, 0);
  } else {
    result = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  }
  
  // Cache the metric result (shorter TTL for metrics)
  await setCached(cacheKey, result, CACHE_TTL.METRICS);
  return result;
}

// Helper to get instance hourly price from Pricing API (with caching)
async function getHourlyPrice(serviceCode, filters) {
  // Create a cache key based on service and filters
  const cacheKey = `price:${serviceCode}:${JSON.stringify(filters)}`;
  
  // Try to get from cache first
  const cachedPrice = await getCached(cacheKey);
  if (cachedPrice !== null) {
    return cachedPrice;
  }
  
  const pricingClient = new PricingClient({ region: 'us-east-1', credentials });
  const params = {
    ServiceCode: serviceCode,
    Filters: filters,
    MaxResults: 1,
    FormatVersion: 'aws_v1'
  };
  
  try {
    const data = await pricingClient.send(new GetProductsCommand(params));
    if (data.PriceList.length > 0) {
      const priceItem = JSON.parse(data.PriceList[0]);
      const onDemand = Object.values(priceItem.terms.OnDemand)[0];
      const priceDim = Object.values(onDemand.priceDimensions)[0];
      const price = parseFloat(priceDim.pricePerUnit.USD);
      
      // Cache pricing data (long TTL as prices don't change often)
      await setCached(cacheKey, price, CACHE_TTL.PRICING);
      return price;
    }
  } catch (err) {
    console.error('Pricing error:', err);
  }
  return 0;
}

// Internal helper to get all regions (with caching)
async function getAllRegions() {
  const cacheKey = 'aws:regions';
  
  // Try to get from cache first
  const cachedRegions = await getCached(cacheKey);
  if (cachedRegions !== null) {
    return cachedRegions;
  }
  
  const ec2 = new EC2Client({ region: 'us-east-1', credentials });
  const data = await ec2.send(new DescribeRegionsCommand({}));
  const regions = data.Regions.map(r => r.RegionName).sort();
  
  // Cache regions for 24 hours
  await setCached(cacheKey, regions, CACHE_TTL.REGIONS);
  return regions;
}

// Helper to send email notification via nodemailer
async function sendNotification(resources, isManual = false) {
  console.log('sendNotification called with:', { resourcesLength: resources.length, isManual, emailUser, receiverEmail });
  if (!emailUser || !emailPass || !receiverEmail) {
    console.log('Skipping email: Missing email configuration');
    throw new Error('Missing email configuration in .env');
  }

  const subject = isManual
    ? 'Manual AWS Resources Notification'
    : 'AWS Unused Resources Notification (>30 days)';
  const body = resources.length
    ? `The following AWS resources were identified:\n\n` +
      resources.map(r => `${r.service.toUpperCase()} in ${r.region}: ${r.id || r.name} (${r.usageStatus}, Cost: $${r.monthlyCost?.toFixed(2) || '0.00'})`).join('\n')
    : 'No unused resources found. This is a test email.';

  const mailOptions = {
    from: `AWS Resource Monitor <${emailUser}>`,
    to: receiverEmail,
    subject: subject,
    text: body
  };

  try {
    console.log('Sending email with options:', mailOptions);
    await transporter.sendMail(mailOptions);
    console.log('Notification email sent via Gmail SMTP');
    return { message: 'Email sent successfully' };
  } catch (err) {
    console.error('Error sending email via nodemailer:', err);
    throw err;
  }
}

// Helper to fetch resources for a specific service and region (with caching)
async function fetchServiceResources(service, region, forceRefresh = false) {
  const cacheKey = `resources:${service}:${region}`;
  
  // Try to get from cache unless force refresh
  if (!forceRefresh) {
    const cachedResources = await getCached(cacheKey);
    if (cachedResources !== null) {
      console.log(`Cache hit for ${service} in ${region}`);
      return cachedResources;
    }
  }
  
  console.log(`Cache miss - fetching ${service} in ${region}`);
  let resources = [];
  let totalCostEstimate = 0;
  const cwRegion = service === 's3' ? 'us-east-1' : region;
  const cwClient = new CloudWatchClient({ region: cwRegion, credentials });

  switch (service) {
    case 'ec2': {
      const ec2Client = new EC2Client({ region, credentials });
      const reservations = await paginateDescribe(ec2Client, DescribeInstancesCommand, {}, 'Reservations');
      resources = reservations.flatMap(res => res.Instances || []).map(inst => ({
        service,
        region,
        id: inst.InstanceId,
        type: inst.InstanceType,
        state: inst.State.Name,
        creation: inst.LaunchTime,
        avgCpu: 0,
        usageStatus: inst.State.Name,
        monthlyCost: 0
      }));

      for (let inst of resources) {
        if (inst.state === 'running') {
          inst.avgCpu = await getMetric(cwClient, 'AWS/EC2', 'CPUUtilization', [{ Name: 'InstanceId', Value: inst.id }], 'Average', 1);
          if (inst.avgCpu < 1) inst.usageStatus = 'idle';
          else if (inst.avgCpu < 10) inst.usageStatus = 'underutilized';
          else inst.usageStatus = 'used';

          const location = regionToLocation[region] || '';
          if (location) {
            const filters = [
              { Type: 'TERM_MATCH', Field: 'instanceType', Value: inst.type },
              { Type: 'TERM_MATCH', Field: 'operatingSystem', Value: 'Linux' },
              { Type: 'TERM_MATCH', Field: 'tenancy', Value: 'Shared' },
              { Type: 'TERM_MATCH', Field: 'capacitystatus', Value: 'Used' },
              { Type: 'TERM_MATCH', Field: 'preInstalledSw', Value: 'NA' },
              { Type: 'TERM_MATCH', Field: 'location', Value: location }
            ];
            const hourly = await getHourlyPrice('AmazonEC2', filters);
            inst.monthlyCost = hourly * 730;
            totalCostEstimate += inst.monthlyCost;
          }
        } else if (inst.state === 'stopped') {
          inst.usageStatus = 'stopped';
          inst.monthlyCost = 0;
        }
      }
      break;
    }
    case 'ebs': {
      const ec2Client = new EC2Client({ region, credentials });
      const volumes = await paginateDescribe(ec2Client, DescribeVolumesCommand, {}, 'Volumes');
      const typePrices = { gp2: 0.10, gp3: 0.08, io1: 0.125, st1: 0.045, sc1: 0.025 };
      resources = volumes.map(vol => {
        const pricePerGb = typePrices[vol.VolumeType] || 0.10;
        const monthlyCost = vol.Size * pricePerGb;
        totalCostEstimate += monthlyCost;
        return {
          service,
          region,
          id: vol.VolumeId,
          type: vol.VolumeType,
          state: vol.State,
          size: vol.Size,
          creation: vol.CreateTime,
          usageStatus: vol.State === 'in-use' ? 'used' : 'idle',
          monthlyCost
        };
      });
      break;
    }
    case 's3': {
      const s3Client = new S3Client({ region: 'us-east-1', credentials });
      const buckets = (await s3Client.send(new ListBucketsCommand({}))).Buckets || [];
      for (let bucket of buckets) {
        let locRes;
        try {
          locRes = await s3Client.send(new GetBucketLocationCommand({ Bucket: bucket.Name }));
        } catch (err) {
          if (err.name !== 'NoSuchBucket') console.error(err);
          continue;
        }
        const bucketRegion = locRes.LocationConstraint || 'us-east-1';
        if (bucketRegion !== region) continue;

        const numObjects = await getMetric(cwClient, 'AWS/S3', 'NumberOfObjects', [
          { Name: 'BucketName', Value: bucket.Name },
          { Name: 'StorageType', Value: 'AllStorageTypes' }
        ], 'Average', 1);
        const sizeBytes = await getMetric(cwClient, 'AWS/S3', 'BucketSizeBytes', [
          { Name: 'BucketName', Value: bucket.Name },
          { Name: 'StorageType', Value: 'StandardStorage' }
        ], 'Average', 1);
        const sizeGB = sizeBytes / (1024 ** 3);
        const usageStatus = numObjects > 0 ? 'used' : 'idle';
        const monthlyCost = sizeGB * 0.023;

        resources.push({
          service,
          region,
          name: bucket.Name,
          created: bucket.CreationDate,
          numObjects,
          sizeGB,
          creation: bucket.CreationDate,
          usageStatus,
          monthlyCost
        });
        totalCostEstimate += monthlyCost;
      }
      break;
    }
    case 'rds': {
      const rdsClient = new RDSClient({ region, credentials });
      const dbInstances = await paginateDescribe(rdsClient, DescribeDBInstancesCommand, {}, 'DBInstances');
      resources = dbInstances.map(db => ({
        service,
        region,
        id: db.DBInstanceIdentifier,
        type: db.DBInstanceClass,
        engine: db.Engine,
        state: db.DBInstanceStatus,
        creation: db.InstanceCreateTime,
        avgCpu: 0,
        usageStatus: db.DBInstanceStatus,
        monthlyCost: 0
      }));

      for (let db of resources) {
        if (db.state === 'available') {
          db.avgCpu = await getMetric(cwClient, 'AWS/RDS', 'CPUUtilization', [{ Name: 'DBInstanceIdentifier', Value: db.id }], 'Average', 1);
          if (db.avgCpu < 1) db.usageStatus = 'idle';
          else if (db.avgCpu < 10) db.usageStatus = 'underutilized';
          else db.usageStatus = 'used';

          const location = regionToLocation[region] || '';
          if (location) {
            const filters = [
              { Type: 'TERM_MATCH', Field: 'instanceType', Value: db.type },
              { Type: 'TERM_MATCH', Field: 'databaseEngine', Value: db.engine.charAt(0).toUpperCase() + db.engine.slice(1) },
              { Type: 'TERM_MATCH', Field: 'deploymentOption', Value: 'Single-AZ' },
              { Type: 'TERM_MATCH', Field: 'location', Value: location }
            ];
            const hourly = await getHourlyPrice('AmazonRDS', filters);
            db.monthlyCost = hourly * 730;
            totalCostEstimate += db.monthlyCost;
          }
        } else if (db.state === 'stopped') {
          db.usageStatus = 'stopped';
          db.monthlyCost = 0;
        }
      }
      break;
    }
    case 'lambda': {
      const lambdaClient = new LambdaClient({ region, credentials });
      const functions = await paginateDescribe(lambdaClient, ListFunctionsCommand, {}, 'Functions');
      resources = functions.map(fn => ({
        service,
        region,
        name: fn.FunctionName,
        runtime: fn.Runtime,
        memory: fn.MemorySize,
        creation: new Date(fn.LastModified),
        invocations: 0,
        usageStatus: 'idle',
        monthlyCost: 0
      }));

      for (let fn of resources) {
        const invocations = await getMetric(cwClient, 'AWS/Lambda', 'Invocations', [{ Name: 'FunctionName', Value: fn.name }], 'Sum', 1);
        fn.invocations = invocations;
        fn.usageStatus = invocations > 0 ? 'used' : 'idle';

        if (invocations > 0) {
          const avgDuration = await getMetric(cwClient, 'AWS/Lambda', 'Duration', [{ Name: 'FunctionName', Value: fn.name }], 'Average', 1);
          const totalDurationS = (avgDuration / 1000) * invocations;
          const gbS = totalDurationS * (fn.memory / 1024);
          const reqCost = invocations * 0.0000002;
          const computeCost = gbS * 0.0000166667;
          fn.monthlyCost = (reqCost + computeCost) * 30;
          totalCostEstimate += fn.monthlyCost;
        }
      }
      break;
    }
    default:
      throw new Error('Invalid service');
  }
  
  const result = { resources, totalCostEstimate };
  
  // Cache the result
  await setCached(cacheKey, result, CACHE_TTL.RESOURCES);
  
  return result;
}

// Serve static frontend files
app.use(express.static('public'));

// API to get all regions
app.get('/api/regions', async (req, res) => {
  try {
    const regions = await getAllRegions();
    res.json(regions);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to fetch regions' });
  }
});

// API to get resources for a service in a region
app.get('/api/resources/:service/:region', async (req, res) => {
  const { service, region } = req.params;
  const forceRefresh = req.query.refresh === 'true';
  let resources = [];
  let totalCostEstimate = 0;

  try {
    if (service === 'all') {
      const regions = region === 'all' ? await getAllRegions() : [region];
      const services = ['ec2', 'ebs', 's3', 'rds', 'lambda'];
      
      // Use Promise.all for parallel fetching when region is not 'all'
      if (region === 'all') {
        const promises = [];
        for (let r of regions) {
          for (let s of services) {
            promises.push(fetchServiceResources(s, r, forceRefresh));
          }
        }
        const results = await Promise.all(promises);
        for (let result of results) {
          resources = resources.concat(result.resources);
          totalCostEstimate += result.totalCostEstimate;
        }
      } else {
        for (let s of services) {
          console.log(`Fetching ${s} in ${region}`);
          const { resources: serviceResources, totalCostEstimate: serviceCost } = await fetchServiceResources(s, region, forceRefresh);
          resources = resources.concat(serviceResources);
          totalCostEstimate += serviceCost;
        }
      }
    } else {
      const { resources: serviceResources, totalCostEstimate: serviceCost } = await fetchServiceResources(service, region, forceRefresh);
      resources = serviceResources;
      totalCostEstimate = serviceCost;
    }

    console.log(`Returning ${resources.length} resources for ${service} in ${region}`);
    res.json({ resources, totalCostEstimate: totalCostEstimate.toFixed(2) });
  } catch (err) {
    console.error(`Error fetching ${service} in ${region}:`, err);
    res.status(500).json({ error: err.message || 'Failed to fetch resources' });
  }
});

// API to clear cache
app.post('/api/clear-cache', async (req, res) => {
  try {
    await clearCache('*');
    res.json({ message: 'Cache cleared successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to clear cache' });
  }
});

// API to get cache stats
app.get('/api/cache-stats', async (req, res) => {
  try {
    const keys = await redisClient.keys('*');
    const stats = {
      totalKeys: keys.length,
      keys: keys.slice(0, 20) // Return first 20 keys for preview
    };
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to get cache stats' });
  }
});

// API to scan all unused resources across all regions/services and send notifications
app.get('/api/scan', async (req, res) => {
  try {
    const regions = await getAllRegions();
    const services = ['ec2', 'ebs', 's3', 'rds', 'lambda'];
    let unusedResources = [];
    let longIdleResources = [];
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    for (let region of regions) {
      for (let service of services) {
        // Force refresh for scan to get latest data
        const { resources } = await fetchServiceResources(service, region, true);
        
        // Process resources for idle detection
        for (let resource of resources) {
          if (resource.usageStatus !== 'used' && resource.usageStatus !== 'available') {
            unusedResources.push(resource);
          }
          
          // Check for long-idle resources (>30 days)
          if (resource.creation && resource.creation < thirtyDaysAgo) {
            if (resource.state === 'stopped' || 
                (resource.usageStatus === 'idle' && resource.avgCpu < 1)) {
              longIdleResources.push(resource);
            }
          }
        }
      }
    }

    lastUnusedResources = unusedResources;
    if (longIdleResources.length > 0) {
      await sendNotification(longIdleResources);
    } else {
      console.log('No long-idle resources found; skipping automatic email');
    }
    res.json({ unusedResources });
  } catch (err) {
    console.error('Error scanning resources:', err);
    res.status(500).json({ error: err.message || 'Failed to scan resources' });
  }
});

// API to send email manually
app.get('/api/send-email', async (req, res) => {
  try {
    const result = await sendNotification(lastUnusedResources, true);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to send email' });
  }
});

// Schedule daily scan at midnight IST
cron.schedule('0 0 * * *', async () => {
  console.log('Running scheduled scan for unused resources at', new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }));
  try {
    const regions = await getAllRegions();
    const services = ['ec2', 'ebs', 's3', 'rds', 'lambda'];
    let longIdleResources = [];
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    for (let region of regions) {
      for (let service of services) {
        // Force refresh for scheduled scan
        const { resources } = await fetchServiceResources(service, region, true);
        
        for (let resource of resources) {
          if (resource.creation && resource.creation < thirtyDaysAgo) {
            if (resource.state === 'stopped' || 
                (resource.usageStatus === 'idle' && resource.avgCpu < 1)) {
              longIdleResources.push(resource);
            }
          }
        }
      }
    }

    if (longIdleResources.length > 0) {
      await sendNotification(longIdleResources);
      console.log('Scheduled scan: Email sent for', longIdleResources.length, 'long-idle resources');
    } else {
      console.log('Scheduled scan: No long-idle resources found; skipping email');
    }
  } catch (err) {
    console.error('Scheduled scan error:', err);
  }
}, {
  timezone: 'Asia/Kolkata'
});

// Graceful shutdown - close Redis connection
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  await redisClient.quit();
  process.exit(0);
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
  console.log(`Redis cache enabled - TTL: Resources=${CACHE_TTL.RESOURCES}s, Regions=${CACHE_TTL.REGIONS}s, Pricing=${CACHE_TTL.PRICING}s`);
});

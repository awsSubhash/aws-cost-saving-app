let chartInstance = null;
let lastUnusedResources = [];

// Debounce function to limit rapid API calls
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// Show/hide loading spinner
function toggleLoading(show) {
  const loadingDiv = document.getElementById('loading');
  loadingDiv.classList.toggle('d-none', !show);
}

async function fetchRegions() {
  toggleLoading(true);
  try {
    const response = await fetch('/api/regions');
    const regions = await response.json();
    const regionSelect = document.getElementById('regionSelect');
    regions.forEach(region => {
      const option = document.createElement('option');
      option.value = region;
      option.textContent = region;
      regionSelect.appendChild(option);
    });
  } catch (err) {
    console.error('Error fetching regions:', err);
  } finally {
    toggleLoading(false);
  }
}

async function fetchResources() {
  toggleLoading(true);
  const service = document.getElementById('serviceSelect').value;
  const region = document.getElementById('regionSelect').value;
  const status = document.getElementById('statusSelect').value;

  let url = '/api/resources/';
  if (service === 'all') {
    url += 'all/all';
  } else {
    url += `${service}/${region}`;
  }

  try {
    const response = await fetch(url);
    const data = await response.json();
    let resources = data.resources || [];
    if (status !== 'all') {
      resources = resources.filter(r => r.usageStatus === status);
    }

    updateTable(resources);
    updateSummary(data.resources, data.totalCostEstimate);
    updateChart(resources);
  } catch (err) {
    console.error('Error fetching resources:', err);
  } finally {
    toggleLoading(false);
  }
}

// Incremental table update to reduce flickering
function updateTable(resources) {
  const tbody = document.getElementById('resourcesTable');
  const existingRows = Array.from(tbody.querySelectorAll('tr'));
  const resourceKeys = resources.map(r => `${r.service}-${r.region}-${r.id || r.name}`);

  // Remove rows for resources no longer present
  existingRows.forEach(row => {
    const key = row.dataset.key;
    if (!resourceKeys.includes(key)) {
      row.style.opacity = '0';
      setTimeout(() => row.remove(), 200); // Fade out
    }
  });

  // Add or update rows
  resources.forEach(r => {
    const key = `${r.service}-${r.region}-${r.id || r.name}`;
    let row = tbody.querySelector(`tr[data-key="${key}"]`);
    if (!row) {
      row = document.createElement('tr');
      row.dataset.key = key;
      row.style.opacity = '0';
      tbody.appendChild(row);
      setTimeout(() => { row.style.opacity = '1'; }, 10); // Fade in
    }
    row.innerHTML = `
      <td>${r.service || ''}</td>
      <td>${r.region || ''}</td>
      <td>${r.id || r.name || ''}</td>
      <td>${r.type || r.runtime || ''}</td>
      <td>${r.state || ''}</td>
      <td>${r.usageStatus || ''}</td>
      <td>${r.avgCpu ? r.avgCpu.toFixed(2) : r.invocations !== undefined ? r.invocations : r.numObjects !== undefined ? r.numObjects : '-'}</td>
      <td>${r.monthlyCost ? r.monthlyCost.toFixed(2) : '0.00'}</td>
    `;
  });
}

async function scanUnused() {
  toggleLoading(true);
  try {
    const response = await fetch('/api/scan');
    const data = await response.json();
    lastUnusedResources = data.unusedResources || [];
    updateUnusedTable(lastUnusedResources);
  } catch (err) {
    console.error('Error scanning unused resources:', err);
  } finally {
    toggleLoading(false);
  }
}

async function sendEmail() {
  toggleLoading(true);
  try {
    const response = await fetch('/api/send-email');
    const result = await response.json();
    alert(result.message || 'Email sent successfully');
  } catch (err) {
    alert('Error sending email: ' + err.message);
  } finally {
    toggleLoading(false);
  }
}

function updateUnusedTable(resources) {
  const tbody = document.getElementById('unusedResourcesTable');
  const existingRows = Array.from(tbody.querySelectorAll('tr'));
  const resourceKeys = resources.map(r => `${r.service}-${r.region}-${r.id || r.name}`);

  // Remove rows for resources no longer present
  existingRows.forEach(row => {
    const key = row.dataset.key;
    if (!resourceKeys.includes(key)) {
      row.style.opacity = '0';
      setTimeout(() => row.remove(), 200); // Fade out
    }
  });

  // Add or update rows
  resources.forEach(r => {
    const key = `${r.service}-${r.region}-${r.id || r.name}`;
    let row = tbody.querySelector(`tr[data-key="${key}"]`);
    if (!row) {
      row = document.createElement('tr');
      row.dataset.key = key;
      row.style.opacity = '0';
      tbody.appendChild(row);
      setTimeout(() => { row.style.opacity = '1'; }, 10); // Fade in
    }
    row.innerHTML = `
      <td>${r.service}</td>
      <td>${r.region}</td>
      <td>${r.id || r.name || ''}</td>
      <td>${r.type || r.runtime || ''}</td>
      <td>${r.state || ''}</td>
      <td>${r.usageStatus || ''}</td>
      <td>${r.avgCpu ? r.avgCpu.toFixed(2) : r.invocations !== undefined ? r.invocations : r.numObjects !== undefined ? r.numObjects : '-'}</td>
      <td>${r.monthlyCost ? r.monthlyCost.toFixed(2) : '0.00'}</td>
    `;
  });
}

function updateSummary(resources, totalCost) {
  const total = resources.length;
  const running = resources.filter(r => r.state === 'running' || r.state === 'available' || r.usageStatus === 'used').length;
  const idle = resources.filter(r => r.usageStatus === 'idle' || r.usageStatus === 'underutilized').length;

  document.getElementById('totalResources').textContent = total;
  document.getElementById('runningResources').textContent = running;
  document.getElementById('idleResources').textContent = idle;
  document.getElementById('totalCost').textContent = parseFloat(totalCost).toFixed(2);
}

function updateChart(resources) {
  const ctx = document.getElementById('statusChart').getContext('2d');
  const statusCounts = {
    running: resources.filter(r => r.state === 'running' || r.state === 'available').length,
    stopped: resources.filter(r => r.state === 'stopped').length,
    idle: resources.filter(r => r.usageStatus === 'idle').length,
    underutilized: resources.filter(r => r.usageStatus === 'underutilized').length,
    used: resources.filter(r => r.usageStatus === 'used').length
  };

  if (chartInstance) {
    // Update existing chart data
    chartInstance.data.datasets[0].data = [
      statusCounts.running,
      statusCounts.stopped,
      statusCounts.idle,
      statusCounts.underutilized,
      statusCounts.used
    ];
    chartInstance.update('none'); // Silent update
  } else {
    chartInstance = new Chart(ctx, {
      type: 'pie',
      data: {
        labels: ['Running', 'Stopped', 'Idle', 'Underutilized', 'Used'],
        datasets: [{
          data: [statusCounts.running, statusCounts.stopped, statusCounts.idle, statusCounts.underutilized, statusCounts.used],
          backgroundColor: ['#36A2EB', '#FF6384', '#FFCE56', '#4BC0C0', '#9966FF']
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false, // Allow fixed height
        animation: false // Disable animations
      }
    });
  }
}

function exportToCSV() {
  const rows = Array.from(document.querySelectorAll('#resourcesTable tr')).map(row => {
    return Array.from(row.cells).map(cell => `"${cell.textContent.replace(/"/g, '""')}"`).join(',');
  });
  const csv = ['Service,Region,ID/Name,Type,State,Usage Status,Avg CPU (%),Monthly Cost ($)'].concat(rows).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'resources.csv';
  a.click();
  URL.revokeObjectURL(url);
}

// Debounced fetchResources
const debouncedFetchResources = debounce(fetchResources, 500);

// Event listeners
document.getElementById('refreshBtn').addEventListener('click', debouncedFetchResources);
document.getElementById('scanBtn').addEventListener('click', scanUnused);
document.getElementById('sendEmailBtn').addEventListener('click', sendEmail);
document.getElementById('exportBtn').addEventListener('click', exportToCSV);
document.getElementById('serviceSelect').addEventListener('change', debouncedFetchResources);
document.getElementById('regionSelect').addEventListener('change', debouncedFetchResources);
document.getElementById('statusSelect').addEventListener('change', debouncedFetchResources);

fetchRegions();
debouncedFetchResources();
setInterval(debouncedFetchResources, 5 * 60 * 1000);

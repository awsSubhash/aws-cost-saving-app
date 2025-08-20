AWS Resource Monitor
A full-stack web application to monitor and optimize AWS resources (EC2, EBS, S3, RDS, Lambda) with a modern, responsive dashboard. It identifies unused or underutilized resources to reduce costs, featuring real-time monitoring, automated email notifications, and data export. Built with Node.js, Express, and AWS SDK, it’s perfect for cloud engineers and DevOps professionals aiming to streamline AWS environments.
🚀 Features

Real-Time Monitoring: Tracks EC2, EBS, S3, RDS, and Lambda across all AWS regions.
Unused Resource Detection: Identifies idle, underutilized, or stopped resources (e.g., empty S3 buckets, stopped EC2 instances) to optimize costs.
Responsive Dashboard: Displays resources in an interactive table (Service, Region, Monthly Cost, Status) with filters and Chart.js visualizations.
Automated Notifications: Sends daily emails (at midnight IST) for resources unused >30 days using nodemailer and node-cron.
Cost Estimation: Calculates monthly costs per resource using AWS Pricing API, potentially saving 20-30% on AWS bills.
Data Export: Downloads resource data as CSV for analysis.
Stable UI: Fixed-size tables and charts (no resizing or flickering) with Bootstrap for responsiveness.

🛠 Technologies

Backend: Node.js, Express, AWS SDK v3 (EC2, EBS, S3, RDS, Lambda, CloudWatch, Pricing API), nodemailer, node-cron
Frontend: HTML, CSS, JavaScript, Bootstrap, Chart.js
Deployment: AWS EC2, Heroku, or local server
Environment: Managed via .env file for AWS credentials and email settings

📸 Screenshot

<img width="1865" height="898" alt="image" src="https://github.com/user-attachments/assets/265ae45e-370f-4be1-b585-ef09aec694c4" />




📋 Prerequisites

Node.js: Version 18 or higher
AWS Account: IAM user with permissions for ec2:Describe*, s3:List*, rds:Describe*, lambda:List*, cloudwatch:GetMetricData, pricing:GetProducts
Gmail Account: For email notifications, with 2-Step Verification and an App Password

🏗 Setup Instructions

Clone the Repository:git clone https://github.com/yourusername/aws-resource-monitor.git
cd aws-resource-monitor


Install Dependencies:npm install


Configure Environment:
Copy .env.example to .env:cp .env.example .env


Edit .env with your credentials:AWS_ACCESS_KEY_ID=your_access_key_id
AWS_SECRET_ACCESS_KEY=your_secret_access_key
EMAIL_USER=your-gmail@gmail.com
EMAIL_PASS=your-gmail-app-password
RECEIVER_EMAIL=receiver@example.com
PORT=3000


Generate a Gmail App Password:
Go to myaccount.google.com > Security > 2-Step Verification > App Passwords.
Select “Mail” and “Other” (name it, e.g., AWSResourceMonitor).
Copy the 16-character App Password to EMAIL_PASS.




Run the Application:npm start


Access the Dashboard:
Open http://localhost:3000 in your browser.



📂 Folder Structure
aws-resource-monitor/
├── node_modules/          # Dependencies
├── public/                # Frontend files
│   ├── index.html         # Dashboard UI
│   ├── style.css          # Custom styles
│   ├── script.js          # Frontend logic
│   └── aws-monitor-screenshot.jpg  # Dashboard screenshot
├── .env.example           # Environment template
├── package.json           # Project metadata
├── server.js              # Backend server
└── README.md              # This file

🎮 Usage

View Resources: Open http://localhost:3000 to see the dashboard with a table (Service, Region, Monthly Cost, Status) and pie chart.
Filter Data: Use dropdowns to filter by service (e.g., EC2, S3), region, or status (e.g., idle, stopped).
Scan Unused Resources: Click “Scan Unused” to identify idle/underutilized resources; emails are sent for resources unused >30 days.
Automated Emails: Daily scans at midnight IST send emails for long-idle resources to RECEIVER_EMAIL.
Manual Email: Click “Send Email” to send a report of the latest unused resources.
Export Data: Click “Export to CSV” to download resource data.
Refresh: Auto-refreshes every 5 minutes or click “Refresh” for instant updates.

🌐 Deployment

Local Server:
Run npm start and access http://localhost:3000.


AWS EC2:
Launch an EC2 instance (e.g., t2.micro, Ubuntu).
Install Node.js:sudo apt update
sudo apt install -y nodejs npm


Copy the project to EC2:scp -r . ubuntu@your-ec2-public-ip:/home/ubuntu/aws-resource-monitor


Set up environment variables in .env on EC2.
Run with a process manager:npm install -g pm2
pm2 start server.js


Configure security group to allow HTTP (port 80) and HTTPS (port 443).
Use Nginx for HTTPS and reverse proxy (optional).


Heroku:
Install Heroku CLI and log in:heroku login


Create a Heroku app:heroku create aws-resource-monitor


Set environment variables:heroku config:set AWS_ACCESS_KEY_ID=your_key
heroku config:set AWS_SECRET_ACCESS_KEY=your_secret
heroku config:set EMAIL_USER=your-gmail
heroku config:set EMAIL_PASS=your-app-password
heroku config:set RECEIVER_EMAIL=receiver@example.com


Deploy:git push heroku main


Open: heroku open


Secure Deployment:
Use HTTPS (e.g., AWS CloudFront or Let’s Encrypt).
Store credentials securely (e.g., AWS Secrets Manager instead of .env).



🔍 Testing

Dashboard:
Open http://localhost:3000 and verify the Resources Table (Service, Region, Monthly Cost, Status) and pie chart load correctly.
Test filters and “Refresh” button.


Unused Resource Scan:
Click “Scan Unused” or run:curl http://localhost:3000/api/scan


Check server logs for:No long-idle resources found; skipping automatic email

orNotification email sent via Gmail SMTP




Email Notifications:
Verify emails in RECEIVER_EMAIL inbox/spam after clicking “Scan Unused” or at midnight IST.
Test manual email:curl http://localhost:3000/api/send-email




CSV Export:
Click “Export to CSV” and check the downloaded file for resource data.



🐞 Troubleshooting

No Resources Displayed:
Verify AWS credentials in .env.
Check IAM permissions:aws sts get-caller-identity


Ensure resources exist:aws ec2 describe-instances --region us-east-1
aws s3api list-buckets




Email Not Sent:
Check .env for EMAIL_USER, EMAIL_PASS, RECEIVER_EMAIL.
Test Gmail App Password:curl http://localhost:3000/api/send-email


Look for logs:Skipping email: Missing email configuration


Ensure Gmail’s ~500 emails/day limit isn’t exceeded.


UI Issues (Flickering, Resizing):
Check browser console (F12 > Console) for errors in public/script.js or public/style.css.
Verify style.css has fixed table/chart sizes.
Test in Chrome/Firefox/Edge.


Scheduled Scans Not Running:
Ensure node-cron is installed:npm list node-cron


Check logs at midnight IST for:Running scheduled scan for unused resources at <date>


Test manually:curl http://localhost:3000/api/scan




API Errors:
Test endpoints:curl http://localhost:3000/api/resources/ec2/us-east-1


Check server logs for AWS SDK errors.




Portfolio: www.subhashcloud.in
Contact: Reach out via LinkedIn or email.

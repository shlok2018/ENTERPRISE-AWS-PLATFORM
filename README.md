# NimbusAI — Enterprise AWS Automation Platform

An AI-powered internal tool for automating complex AWS workflows, built with Node.js, AWS SDK v3, and Gemini AI.

## Live Demo
🔗 Coming soon

## Features
- 🤖 AI Command Center powered by Gemini AI
- ☁️ Real-time AWS infrastructure monitoring
- 🔐 JWT authentication with bcrypt password hashing
- 💰 FinOps cost optimization engine
- 🛡️ Security Hub with auto-remediation guidance
- ⚙️ IaC Studio — generates CloudFormation, Terraform, CDK, Pulumi
- 🔄 CI/CD Pipeline builder
- 📊 CloudWatch monitoring dashboard
- 30+ AWS service modules

## Tech Stack
- **Frontend:** HTML, CSS, JavaScript
- **Backend:** Node.js, Express.js
- **AI:** Google Gemini AI API
- **Cloud:** AWS SDK v3 (EC2, S3, Lambda, RDS, ECS, IAM, CloudWatch, Cost Explorer)
- **Auth:** JWT + bcryptjs
- **Deployment:** Vercel (frontend) + Render (backend)

## AWS Services Integrated
EC2 · S3 · Lambda · RDS · ECS/Fargate · EKS · IAM · CloudWatch · Cost Explorer · CloudTrail · Security Hub · CloudFormation

## Setup Instructions

### Prerequisites
- Node.js v18+
- AWS Account with IAM credentials
- Google Gemini API key (free at aistudio.google.com)

### Backend Setup
```bash
cd nimbus-backend
npm install
cp .env.example .env
# Add your keys to .env
node server.js
```

### Frontend Setup
```bash
cd frontend
npx serve .
# Open http://localhost:3000/login.html
```

### Environment Variables
cat > backend/.env.example << 'EOF'
AWS_ACCESS_KEY_ID=your_aws_access_key_here
AWS_SECRET_ACCESS_KEY=your_aws_secret_key_here
AWS_REGION=us-east-1
GEMINI_API_KEY=your_gemini_api_key_here
JWT_SECRET=your_jwt_secret_here
PORT=3001

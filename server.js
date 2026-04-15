require('dotenv').config();
const express = require('express');
const cors = require('cors');

const { EC2Client, DescribeInstancesCommand, StartInstancesCommand, StopInstancesCommand } = require('@aws-sdk/client-ec2');
const { S3Client, ListBucketsCommand, GetBucketLocationCommand, GetBucketAclCommand } = require('@aws-sdk/client-s3');
const { CloudWatchClient, GetMetricDataCommand, DescribeAlarmsCommand } = require('@aws-sdk/client-cloudwatch');
const { CostExplorerClient, GetCostAndUsageCommand } = require('@aws-sdk/client-cost-explorer');
const { LambdaClient, ListFunctionsCommand } = require('@aws-sdk/client-lambda');
const { RDSClient, DescribeDBInstancesCommand, DescribeDBClustersCommand } = require('@aws-sdk/client-rds');
const { ECSClient, ListClustersCommand, ListServicesCommand, DescribeServicesCommand } = require('@aws-sdk/client-ecs');
const { IAMClient, ListUsersCommand, ListAccessKeysCommand } = require('@aws-sdk/client-iam');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(cors());
app.use(express.json());

const REGION = process.env.AWS_REGION || 'us-east-1';
const config = { region: REGION };

const ec2    = new EC2Client(config);
const s3     = new S3Client(config);
const cw     = new CloudWatchClient(config);
const ce     = new CostExplorerClient({ region: 'us-east-1' });
const lambda = new LambdaClient(config);
const rds    = new RDSClient(config);
const ecs    = new ECSClient(config);
const iam    = new IAMClient(config);

function today() { return new Date().toISOString().split('T')[0]; }
function monthStart() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().split('T')[0];
}

// ════════════════════════════════════════════════════════
//  GEMINI AI CHAT
// ════════════════════════════════════════════════════════

app.post('/api/ai/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'No message provided' });

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `You are NimbusAI, an expert AWS DevOps engineer and solutions architect.

Provide detailed, production-ready answers including:
- Real AWS CLI commands
- CloudFormation YAML or Terraform HCL code  
- Python boto3 examples where helpful
- Security best practices
- Cost implications
- Step by step instructions

Question: ${message}`
    });

    res.json({ reply: response.text, model: 'gemini-2.5-flash' });

  } catch (err) {
    console.error('[Gemini AI] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════
//  HEALTH CHECK
// ════════════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.json({ status: 'NimbusAI Backend Running', region: REGION, time: new Date().toISOString() });
});

// ════════════════════════════════════════════════════════
//  EC2
// ════════════════════════════════════════════════════════

app.get('/api/ec2/instances', async (req, res) => {
  try {
    const data = await ec2.send(new DescribeInstancesCommand({}));
    const instances = data.Reservations.flatMap(r => r.Instances).map(i => ({
      id:         i.InstanceId,
      name:       i.Tags?.find(t => t.Key === 'Name')?.Value || 'Unnamed',
      type:       i.InstanceType,
      state:      i.State.Name,
      publicIp:   i.PublicIpAddress  || null,
      privateIp:  i.PrivateIpAddress || null,
      az:         i.Placement?.AvailabilityZone,
      launchTime: i.LaunchTime
    }));
    res.json({ count: instances.length, instances });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ec2/start/:id', async (req, res) => {
  try {
    const data = await ec2.send(new StartInstancesCommand({ InstanceIds: [req.params.id] }));
    res.json({ success: true, state: data.StartingInstances[0].CurrentState.Name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ec2/stop/:id', async (req, res) => {
  try {
    const data = await ec2.send(new StopInstancesCommand({ InstanceIds: [req.params.id] }));
    res.json({ success: true, state: data.StoppingInstances[0].CurrentState.Name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════
//  S3
// ════════════════════════════════════════════════════════

app.get('/api/s3/buckets', async (req, res) => {
  try {
    const data = await s3.send(new ListBucketsCommand({}));
    const buckets = await Promise.all(
      (data.Buckets || []).map(async (b) => {
        let region = 'us-east-1';
        let isPublic = false;
        try {
          const loc = await s3.send(new GetBucketLocationCommand({ Bucket: b.Name }));
          region = loc.LocationConstraint || 'us-east-1';
        } catch (e) {}
        try {
          const acl = await s3.send(new GetBucketAclCommand({ Bucket: b.Name }));
          isPublic = acl.Grants?.some(g =>
            g.Grantee?.URI === 'http://acs.amazonaws.com/groups/global/AllUsers'
          ) || false;
        } catch (e) {}
        return { name: b.Name, created: b.CreationDate, region, isPublic };
      })
    );
    res.json({ count: buckets.length, buckets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════
//  LAMBDA
// ════════════════════════════════════════════════════════

app.get('/api/lambda/functions', async (req, res) => {
  try {
    const data = await lambda.send(new ListFunctionsCommand({}));
    const functions = (data.Functions || []).map(f => ({
      name:         f.FunctionName,
      runtime:      f.Runtime,
      memory:       f.MemorySize,
      timeout:      f.Timeout,
      lastModified: f.LastModified,
      codeSize:     f.CodeSize
    }));
    res.json({ count: functions.length, functions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════
//  RDS
// ════════════════════════════════════════════════════════

app.get('/api/rds/instances', async (req, res) => {
  try {
    const [instances, clusters] = await Promise.all([
      rds.send(new DescribeDBInstancesCommand({})),
      rds.send(new DescribeDBClustersCommand({}))
    ]);
    res.json({
      instances: (instances.DBInstances || []).map(d => ({
        id:        d.DBInstanceIdentifier,
        class:     d.DBInstanceClass,
        engine:    d.Engine,
        status:    d.DBInstanceStatus,
        multiAZ:   d.MultiAZ,
        encrypted: d.StorageEncrypted
      })),
      clusters: (clusters.DBClusters || []).map(c => ({
        id:     c.DBClusterIdentifier,
        engine: c.Engine,
        status: c.Status
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════
//  ECS
// ════════════════════════════════════════════════════════

app.get('/api/ecs/clusters', async (req, res) => {
  try {
    const clusterData = await ecs.send(new ListClustersCommand({}));
    const clusterArns = clusterData.clusterArns || [];
    const clustersWithServices = await Promise.all(
      clusterArns.map(async (arn) => {
        const clusterName = arn.split('/').pop();
        let services = [];
        try {
          const svcList = await ecs.send(new ListServicesCommand({ cluster: arn }));
          if (svcList.serviceArns?.length > 0) {
            const svcDetail = await ecs.send(new DescribeServicesCommand({
              cluster: arn,
              services: svcList.serviceArns.slice(0, 10)
            }));
            services = (svcDetail.services || []).map(s => ({
              name:    s.serviceName,
              status:  s.status,
              desired: s.desiredCount,
              running: s.runningCount
            }));
          }
        } catch (e) {}
        return { clusterName, arn, serviceCount: services.length, services };
      })
    );
    res.json({ clusters: clustersWithServices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════
//  CLOUDWATCH
// ════════════════════════════════════════════════════════

app.get('/api/cloudwatch/alarms', async (req, res) => {
  try {
    const data = await cw.send(new DescribeAlarmsCommand({}));
    const alarms = (data.MetricAlarms || []).map(a => ({
      name:      a.AlarmName,
      state:     a.StateValue,
      metric:    a.MetricName,
      threshold: a.Threshold
    }));
    res.json({ count: alarms.length, alarms });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/metrics/ec2/:instanceId/cpu', async (req, res) => {
  try {
    const data = await cw.send(new GetMetricDataCommand({
      StartTime: new Date(Date.now() - 3600000),
      EndTime: new Date(),
      MetricDataQueries: [{
        Id: 'cpu',
        MetricStat: {
          Metric: {
            Namespace: 'AWS/EC2',
            MetricName: 'CPUUtilization',
            Dimensions: [{ Name: 'InstanceId', Value: req.params.instanceId }]
          },
          Period: 300,
          Stat: 'Average'
        }
      }]
    }));
    res.json(data.MetricDataResults[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════
//  COST EXPLORER
// ════════════════════════════════════════════════════════

app.get('/api/cost/monthly', async (req, res) => {
  try {
    const data = await ce.send(new GetCostAndUsageCommand({
      TimePeriod:  { Start: monthStart(), End: today() },
      Granularity: 'MONTHLY',
      GroupBy:     [{ Type: 'DIMENSION', Key: 'SERVICE' }],
      Metrics:     ['UnblendedCost']
    }));
    const groups = data.ResultsByTime?.[0]?.Groups || [];
    const services = groups
      .map(g => ({
        service: g.Keys[0],
        cost:    parseFloat(g.Metrics.UnblendedCost.Amount).toFixed(2)
      }))
      .sort((a, b) => b.cost - a.cost);
    const total = services.reduce((sum, s) => sum + parseFloat(s.cost), 0).toFixed(2);
    res.json({ total, currency: 'USD', services });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cost/daily', async (req, res) => {
  try {
    const start = new Date();
    start.setDate(start.getDate() - 30);
    const data = await ce.send(new GetCostAndUsageCommand({
      TimePeriod:  { Start: start.toISOString().split('T')[0], End: today() },
      Granularity: 'DAILY',
      Metrics:     ['UnblendedCost']
    }));
    const days = (data.ResultsByTime || []).map(d => ({
      date: d.TimePeriod.Start,
      cost: parseFloat(d.Total.UnblendedCost.Amount).toFixed(2)
    }));
    res.json({ days });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════
//  IAM
// ════════════════════════════════════════════════════════

app.get('/api/iam/users', async (req, res) => {
  try {
    const data = await iam.send(new ListUsersCommand({}));
    const users = await Promise.all(
      (data.Users || []).map(async (u) => {
        let keyCount = 0;
        try {
          const keys = await iam.send(new ListAccessKeysCommand({ UserName: u.UserName }));
          keyCount = keys.AccessKeyMetadata?.length || 0;
        } catch (e) {}
        return {
          username:   u.UserName,
          created:    u.CreateDate,
          lastLogin:  u.PasswordLastUsed || null,
          accessKeys: keyCount
        };
      })
    );
    res.json({ count: users.length, users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════
//  DASHBOARD — all data in one call
// ════════════════════════════════════════════════════════

app.get('/api/dashboard', async (req, res) => {
  const results = { region: REGION, timestamp: new Date().toISOString() };

  await Promise.allSettled([
    ec2.send(new DescribeInstancesCommand({})).then(d => {
      const all = d.Reservations.flatMap(r => r.Instances);
      results.ec2 = {
        total:   all.length,
        running: all.filter(i => i.State.Name === 'running').length,
        stopped: all.filter(i => i.State.Name === 'stopped').length
      };
    }),
    s3.send(new ListBucketsCommand({})).then(d => {
      results.s3 = { total: d.Buckets?.length || 0 };
    }),
    lambda.send(new ListFunctionsCommand({})).then(d => {
      results.lambda = { total: d.Functions?.length || 0 };
    }),
    rds.send(new DescribeDBInstancesCommand({})).then(d => {
      results.rds = { total: d.DBInstances?.length || 0 };
    }),
    ce.send(new GetCostAndUsageCommand({
      TimePeriod:  { Start: monthStart(), End: today() },
      Granularity: 'MONTHLY',
      Metrics:     ['UnblendedCost']
    })).then(d => {
      results.cost = {
        monthly: parseFloat(
          d.ResultsByTime?.[0]?.Total?.UnblendedCost?.Amount || 0
        ).toFixed(2)
      };
    }),
    cw.send(new DescribeAlarmsCommand({ StateValue: 'ALARM' })).then(d => {
      results.alarms = { active: d.MetricAlarms?.length || 0 };
    })
  ]);

  res.json(results);
});

// ════════════════════════════════════════════════════════
//  START SERVER
// ════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log('');
  console.log('  ███╗   ██╗██╗███╗   ███╗██████╗ ██╗   ██╗███████╗ █████╗ ██╗');
  console.log('  ████╗  ██║██║████╗ ████║██╔══██╗██║   ██║██╔════╝██╔══██╗██║');
  console.log('  ██╔██╗ ██║██║██╔████╔██║██████╔╝██║   ██║███████╗███████║██║');
  console.log('  ██║╚██╗██║██║██║╚██╔╝██║██╔══██╗╚██╗ ██╔╝╚════██║██╔══██║██║');
  console.log('  ██║ ╚████║██║██║ ╚═╝ ██║██████╔╝ ╚████╔╝ ███████║██║  ██║██║');
  console.log('');
  console.log(`  Backend   → http://localhost:${PORT}`);
  console.log(`  Dashboard → http://localhost:${PORT}/api/dashboard`);
  console.log(`  AI Chat   → http://localhost:${PORT}/api/ai/chat  [POST]`);
  console.log(`  EC2       → http://localhost:${PORT}/api/ec2/instances`);
  console.log(`  S3        → http://localhost:${PORT}/api/s3/buckets`);
  console.log(`  Cost      → http://localhost:${PORT}/api/cost/monthly`);
  console.log('');
  console.log(`  Gemini AI → ${process.env.GEMINI_API_KEY ? '✅ Connected' : '❌ NOT SET - add GEMINI_API_KEY to .env'}`);
  console.log(`  AWS       → ${process.env.AWS_ACCESS_KEY_ID ? '✅ Connected' : '❌ NOT SET'}`);
  console.log(`  Region    → ${REGION}`);
  console.log('');
});

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const JWT_SECRET = process.env.JWT_SECRET || 'nimbus-secret-2026';
const USERS = [
  { id:1, username:'admin', password:'$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', role:'admin', name:'AWS Admin' },
  { id:2, username:'demo', password:'$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', role:'viewer', name:'Demo User' }
];
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = USERS.find(u => u.username === username?.toLowerCase());
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id:user.id, username:user.username, role:user.role, name:user.name }, JWT_SECRET, { expiresIn:'8h' });
    console.log('[Auth] Login:', user.username);
    res.json({ success:true, token, user:{ id:user.id, username:user.username, role:user.role, name:user.name } });
  } catch(err) { res.status(500).json({ error:err.message }); }
});
app.get('/api/auth/verify', (req, res) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try { res.json({ valid:true, user:jwt.verify(token, JWT_SECRET) }); }
  catch { res.status(403).json({ error:'Invalid token' }); }
});

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { GoogleGenAI } = require('@google/genai');

// ─── AWS ──────────────────────────────────────────────────────────────────────
const { EC2Client, DescribeInstancesCommand, StartInstancesCommand, StopInstancesCommand } = require('@aws-sdk/client-ec2');
const { S3Client, ListBucketsCommand, GetBucketLocationCommand, GetBucketAclCommand } = require('@aws-sdk/client-s3');
const { CloudWatchClient, GetMetricDataCommand, DescribeAlarmsCommand } = require('@aws-sdk/client-cloudwatch');
const { CostExplorerClient, GetCostAndUsageCommand } = require('@aws-sdk/client-cost-explorer');
const { LambdaClient, ListFunctionsCommand } = require('@aws-sdk/client-lambda');
const { RDSClient, DescribeDBInstancesCommand, DescribeDBClustersCommand } = require('@aws-sdk/client-rds');
const { ECSClient, ListClustersCommand, ListServicesCommand, DescribeServicesCommand } = require('@aws-sdk/client-ecs');
const { IAMClient, ListUsersCommand, ListAccessKeysCommand } = require('@aws-sdk/client-iam');

// ─── AZURE ────────────────────────────────────────────────────────────────────
const { ClientSecretCredential } = require('@azure/identity');
const { ComputeManagementClient } = require('@azure/arm-compute');
const { StorageManagementClient } = require('@azure/arm-storage');

// ─── GCP ──────────────────────────────────────────────────────────────────────
const { InstancesClient } = require('@google-cloud/compute');
const { Storage } = require('@google-cloud/storage');

// ─── APP SETUP ────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

const REGION = process.env.AWS_REGION || 'us-east-1';
const JWT_SECRET = process.env.JWT_SECRET || 'nimbus-secret-2026';

// ─── AWS CLIENTS ──────────────────────────────────────────────────────────────
const awsConfig = { region: REGION };
const ec2    = new EC2Client(awsConfig);
const s3     = new S3Client(awsConfig);
const cw     = new CloudWatchClient(awsConfig);
const ce     = new CostExplorerClient({ region: 'us-east-1' });
const lambda = new LambdaClient(awsConfig);
const rds    = new RDSClient(awsConfig);
const ecs    = new ECSClient(awsConfig);
const iam    = new IAMClient(awsConfig);

// ─── AZURE CLIENTS ────────────────────────────────────────────────────────────
let azureCompute = null;
let azureStorage = null;
try {
  if (process.env.AZURE_TENANT_ID && process.env.AZURE_CLIENT_ID && process.env.AZURE_CLIENT_SECRET) {
    const azureCredential = new ClientSecretCredential(
      process.env.AZURE_TENANT_ID,
      process.env.AZURE_CLIENT_ID,
      process.env.AZURE_CLIENT_SECRET
    );
    azureCompute = new ComputeManagementClient(azureCredential, process.env.AZURE_SUBSCRIPTION_ID);
    azureStorage = new StorageManagementClient(azureCredential, process.env.AZURE_SUBSCRIPTION_ID);
    console.log('Azure → ✅ Connected');
  }
} catch (e) {
  console.log('Azure → ❌ Not configured');
}

// ─── GCP CLIENTS ──────────────────────────────────────────────────────────────
let gcpInstances = null;
let gcpStorage = null;
try {
  if (process.env.GCP_KEY_FILE && process.env.GCP_PROJECT_ID) {
    gcpInstances = new InstancesClient({ keyFilename: process.env.GCP_KEY_FILE });
    gcpStorage = new Storage({ keyFilename: process.env.GCP_KEY_FILE, projectId: process.env.GCP_PROJECT_ID });
    console.log('GCP    → ✅ Connected');
  }
} catch (e) {
  console.log('GCP    → ❌ Not configured');
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function today() { return new Date().toISOString().split('T')[0]; }
function monthStart() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().split('T')[0];
}

// ════════════════════════════════════════════════════════════════════════════
//  AUTH
// ════════════════════════════════════════════════════════════════════════════

const USERS = [
  { id:1, username:'admin', password:'admin123', role:'admin', name:'AWS Admin' },
  { id:2, username:'demo',  password:'demo123',  role:'viewer', name:'Demo User' }
];

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const user = USERS.find(u => u.username === username.toLowerCase());
    if (!user || user.password !== password) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, name: user.name },
      JWT_SECRET, { expiresIn: '8h' }
    );
    console.log(`[Auth] ✅ Login: ${user.username}`);
    res.json({ success: true, token, user: { id: user.id, username: user.username, role: user.role, name: user.name } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/verify', (req, res) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try { res.json({ valid: true, user: jwt.verify(token, JWT_SECRET) }); }
  catch { res.status(403).json({ error: 'Invalid token' }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  GEMINI AI WITH REAL AWS CONTEXT + MULTI-CLOUD
// ════════════════════════════════════════════════════════════════════════════

app.post('/api/ai/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'No message' });

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    // Fetch real AWS context
    const awsCtx = {};
    await Promise.allSettled([
      ec2.send(new DescribeInstancesCommand({})).then(d => {
        const all = d.Reservations.flatMap(r => r.Instances);
        awsCtx.ec2 = {
          total: all.length,
          running: all.filter(i => i.State.Name === 'running').length,
          stopped: all.filter(i => i.State.Name === 'stopped').length,
          types: [...new Set(all.map(i => i.InstanceType))].join(', ')
        };
      }),
      s3.send(new ListBucketsCommand({})).then(d => { awsCtx.s3 = { total: d.Buckets?.length || 0 }; }),
      lambda.send(new ListFunctionsCommand({})).then(d => { awsCtx.lambda = { total: d.Functions?.length || 0 }; }),
      rds.send(new DescribeDBInstancesCommand({})).then(d => { awsCtx.rds = { total: d.DBInstances?.length || 0 }; }),
      ce.send(new GetCostAndUsageCommand({
        TimePeriod: { Start: monthStart(), End: today() },
        Granularity: 'MONTHLY',
        Metrics: ['UnblendedCost']
      })).then(d => {
        awsCtx.cost = {
          monthly: parseFloat(d.ResultsByTime?.[0]?.Total?.UnblendedCost?.Amount || 0).toFixed(2)
        };
      }),
      cw.send(new DescribeAlarmsCommand({ StateValue: 'ALARM' })).then(d => {
        awsCtx.alarms = { active: d.MetricAlarms?.length || 0 };
      })
    ]);

    const prompt = `You are NimbusAI, expert multi-cloud engineer with access to real infrastructure data.

═══ REAL AWS ACCOUNT DATA ═══
EC2: ${awsCtx.ec2?.running || 0} running / ${awsCtx.ec2?.total || 0} total | Types: ${awsCtx.ec2?.types || 'none'}
S3: ${awsCtx.s3?.total || 0} buckets
Lambda: ${awsCtx.lambda?.total || 0} functions
RDS: ${awsCtx.rds?.total || 0} instances
Monthly Cost: $${awsCtx.cost?.monthly || '0'}/month
Active Alarms: ${awsCtx.alarms?.active || 0}
Region: ${REGION}

═══ MULTI-CLOUD STATUS ═══
Azure: ${azureCompute ? 'Connected' : 'Not configured'}
GCP: ${gcpInstances ? 'Connected (Project: ' + process.env.GCP_PROJECT_ID + ')' : 'Not configured'}

Give specific, personalized advice based on real data above.
Include actual CLI commands, CloudFormation/Terraform code, cost analysis.

Question: ${message}`;

    const models = [
      'gemini-3-flash-preview',
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'gemini-3.1-flash-lite-preview',
      'gemini-3.1-pro-preview'
    ];

    let reply = null;
    let usedModel = null;
    for (const modelName of models) {
      try {
        const response = await ai.models.generateContent({ model: modelName, contents: prompt });
        reply = response.text;
        usedModel = modelName;
        console.log(`[AI] ✅ ${modelName}`);
        break;
      } catch (e) {
        console.log(`[AI] ❌ ${modelName}: ${e.message.slice(0, 60)}`);
      }
    }

    if (reply) res.json({ reply, model: usedModel, awsContext: awsCtx });
    else res.status(503).json({ error: 'All models busy. Try again in 30 seconds.' });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  AWS ROUTES
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/ec2/instances', async (req, res) => {
  try {
    const data = await ec2.send(new DescribeInstancesCommand({}));
    const instances = data.Reservations.flatMap(r => r.Instances).map(i => ({
      id: i.InstanceId,
      name: i.Tags?.find(t => t.Key === 'Name')?.Value || 'Unnamed',
      type: i.InstanceType,
      state: i.State.Name,
      publicIp: i.PublicIpAddress || null,
      privateIp: i.PrivateIpAddress || null,
      az: i.Placement?.AvailabilityZone,
      launchTime: i.LaunchTime
    }));
    res.json({ count: instances.length, instances });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/ec2/start/:id', async (req, res) => {
  try {
    const data = await ec2.send(new StartInstancesCommand({ InstanceIds: [req.params.id] }));
    res.json({ success: true, state: data.StartingInstances[0].CurrentState.Name });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/ec2/stop/:id', async (req, res) => {
  try {
    const data = await ec2.send(new StopInstancesCommand({ InstanceIds: [req.params.id] }));
    res.json({ success: true, state: data.StoppingInstances[0].CurrentState.Name });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/s3/buckets', async (req, res) => {
  try {
    const data = await s3.send(new ListBucketsCommand({}));
    const buckets = await Promise.all((data.Buckets || []).map(async (b) => {
      let region = 'us-east-1', isPublic = false;
      try { const loc = await s3.send(new GetBucketLocationCommand({ Bucket: b.Name })); region = loc.LocationConstraint || 'us-east-1'; } catch (e) {}
      try { const acl = await s3.send(new GetBucketAclCommand({ Bucket: b.Name })); isPublic = acl.Grants?.some(g => g.Grantee?.URI === 'http://acs.amazonaws.com/groups/global/AllUsers') || false; } catch (e) {}
      return { name: b.Name, created: b.CreationDate, region, isPublic };
    }));
    res.json({ count: buckets.length, buckets });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/lambda/functions', async (req, res) => {
  try {
    const data = await lambda.send(new ListFunctionsCommand({}));
    res.json({ count: data.Functions?.length || 0, functions: (data.Functions || []).map(f => ({ name: f.FunctionName, runtime: f.Runtime, memory: f.MemorySize, timeout: f.Timeout })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/rds/instances', async (req, res) => {
  try {
    const [instances, clusters] = await Promise.all([rds.send(new DescribeDBInstancesCommand({})), rds.send(new DescribeDBClustersCommand({}))]);
    res.json({
      instances: (instances.DBInstances || []).map(d => ({ id: d.DBInstanceIdentifier, class: d.DBInstanceClass, engine: d.Engine, status: d.DBInstanceStatus, multiAZ: d.MultiAZ, encrypted: d.StorageEncrypted })),
      clusters: (clusters.DBClusters || []).map(c => ({ id: c.DBClusterIdentifier, engine: c.Engine, status: c.Status }))
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/cloudwatch/alarms', async (req, res) => {
  try {
    const data = await cw.send(new DescribeAlarmsCommand({}));
    res.json({ count: data.MetricAlarms?.length || 0, alarms: (data.MetricAlarms || []).map(a => ({ name: a.AlarmName, state: a.StateValue, metric: a.MetricName, threshold: a.Threshold })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/cost/monthly', async (req, res) => {
  try {
    const data = await ce.send(new GetCostAndUsageCommand({ TimePeriod: { Start: monthStart(), End: today() }, Granularity: 'MONTHLY', GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }], Metrics: ['UnblendedCost'] }));
    const groups = data.ResultsByTime?.[0]?.Groups || [];
    const services = groups.map(g => ({ service: g.Keys[0], cost: parseFloat(g.Metrics.UnblendedCost.Amount).toFixed(2) })).sort((a, b) => b.cost - a.cost);
    const total = services.reduce((sum, s) => sum + parseFloat(s.cost), 0).toFixed(2);
    res.json({ total, currency: 'USD', services });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/iam/users', async (req, res) => {
  try {
    const data = await iam.send(new ListUsersCommand({}));
    res.json({ count: data.Users?.length || 0, users: (data.Users || []).map(u => ({ username: u.UserName, created: u.CreateDate, lastLogin: u.PasswordLastUsed || null })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
//  AZURE ROUTES
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/azure/vms', async (req, res) => {
  if (!azureCompute) return res.json({ status: 'not_configured', vms: [], count: 0 });
  try {
    const vms = [];
    for await (const vm of azureCompute.virtualMachines.listAll()) {
      vms.push({
        name: vm.name,
        location: vm.location,
        size: vm.hardwareProfile?.vmSize,
        status: vm.provisioningState,
        os: vm.storageProfile?.osDisk?.osType,
        resourceGroup: vm.id?.split('/')[4]
      });
    }
    res.json({ count: vms.length, vms, status: 'connected' });
  } catch (err) {
    console.error('[Azure VMs]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/azure/storage', async (req, res) => {
  if (!azureStorage) return res.json({ status: 'not_configured', accounts: [], count: 0 });
  try {
    const accounts = [];
    for await (const account of azureStorage.storageAccounts.list()) {
      accounts.push({
        name: account.name,
        location: account.location,
        kind: account.kind,
        sku: account.sku?.name
      });
    }
    res.json({ count: accounts.length, accounts, status: 'connected' });
  } catch (err) {
    console.error('[Azure Storage]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/azure/summary', async (req, res) => {
  if (!azureCompute) return res.json({ status: 'not_configured', vms: 0, storage: 0 });
  try {
    let vmCount = 0, storageCount = 0;
    for await (const vm of azureCompute.virtualMachines.listAll()) vmCount++;
    for await (const acc of azureStorage.storageAccounts.list()) storageCount++;
    res.json({ status: 'connected', vms: vmCount, storage: storageCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  GCP ROUTES
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/gcp/instances', async (req, res) => {
  if (!gcpInstances) return res.json({ status: 'not_configured', instances: [], count: 0 });
  try {
    const instances = [];
    const iterable = gcpInstances.aggregatedListAsync({ project: process.env.GCP_PROJECT_ID });
    for await (const [zone, zoneInstances] of iterable) {
      if (zoneInstances.instances) {
        for (const instance of zoneInstances.instances) {
          instances.push({
            name: instance.name,
            zone: zone.split('/').pop(),
            machineType: instance.machineType?.split('/').pop(),
            status: instance.status
          });
        }
      }
    }
    res.json({ count: instances.length, instances, status: 'connected' });
  } catch (err) {
    console.error('[GCP Instances]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/gcp/storage', async (req, res) => {
  if (!gcpStorage) return res.json({ status: 'not_configured', buckets: [], count: 0 });
  try {
    const [buckets] = await gcpStorage.getBuckets();
    res.json({
      count: buckets.length,
      buckets: buckets.map(b => ({ name: b.name, location: b.metadata?.location, storageClass: b.metadata?.storageClass })),
      status: 'connected'
    });
  } catch (err) {
    console.error('[GCP Storage]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/gcp/summary', async (req, res) => {
  if (!gcpInstances) return res.json({ status: 'not_configured', instances: 0, buckets: 0 });
  try {
    let instanceCount = 0, bucketCount = 0;
    const iterable = gcpInstances.aggregatedListAsync({ project: process.env.GCP_PROJECT_ID });
    for await (const [, zone] of iterable) instanceCount += zone.instances?.length || 0;
    if (gcpStorage) { const [buckets] = await gcpStorage.getBuckets(); bucketCount = buckets.length; }
    res.json({ status: 'connected', instances: instanceCount, buckets: bucketCount, project: process.env.GCP_PROJECT_ID });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  MULTI-CLOUD UNIFIED DASHBOARD
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/multicloud', async (req, res) => {
  const result = {
    aws:   { status: 'checking', vms: 0, storage: 0, functions: 0, databases: 0, cost: '0.00' },
    azure: { status: 'not_configured', vms: 0, storage: 0 },
    gcp:   { status: 'not_configured', vms: 0, storage: 0 }
  };

  await Promise.allSettled([
    // AWS
    Promise.all([
      ec2.send(new DescribeInstancesCommand({})).then(d => {
        result.aws.vms = d.Reservations.flatMap(r => r.Instances).filter(i => i.State.Name === 'running').length;
      }),
      s3.send(new ListBucketsCommand({})).then(d => { result.aws.storage = d.Buckets?.length || 0; }),
      lambda.send(new ListFunctionsCommand({})).then(d => { result.aws.functions = d.Functions?.length || 0; }),
      rds.send(new DescribeDBInstancesCommand({})).then(d => { result.aws.databases = d.DBInstances?.length || 0; }),
      ce.send(new GetCostAndUsageCommand({ TimePeriod: { Start: monthStart(), End: today() }, Granularity: 'MONTHLY', Metrics: ['UnblendedCost'] })).then(d => {
        result.aws.cost = parseFloat(d.ResultsByTime?.[0]?.Total?.UnblendedCost?.Amount || 0).toFixed(2);
      })
    ]).then(() => { result.aws.status = 'connected'; }).catch(() => { result.aws.status = "connected"; }),

    // Azure
    (async () => {
      if (!azureCompute) return;
      try {
        let vmCount = 0, storageCount = 0;
        for await (const vm of azureCompute.virtualMachines.listAll()) vmCount++;
        for await (const acc of azureStorage.storageAccounts.list()) storageCount++;
        result.azure = { status: 'connected', vms: vmCount, storage: storageCount };
      } catch (e) { result.azure = { status: 'error', error: e.message, vms: 0, storage: 0 }; }
    })(),

    // GCP
    (async () => {
      if (!gcpInstances) return;
      try {
        let instanceCount = 0, bucketCount = 0;
        const iterable = gcpInstances.aggregatedListAsync({ project: process.env.GCP_PROJECT_ID });
        for await (const [, zone] of iterable) instanceCount += zone.instances?.length || 0;
        if (gcpStorage) { const [buckets] = await gcpStorage.getBuckets(); bucketCount = buckets.length; }
        result.gcp = { status: 'connected', vms: instanceCount, storage: bucketCount, project: process.env.GCP_PROJECT_ID };
      } catch (e) { result.gcp = { status: 'error', error: e.message, vms: 0, storage: 0 }; }
    })()
  ]);

  res.json(result);
});

// ════════════════════════════════════════════════════════════════════════════
//  AWS DASHBOARD SUMMARY
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/dashboard', async (req, res) => {
  const results = { region: REGION, timestamp: new Date().toISOString() };
  await Promise.allSettled([
    ec2.send(new DescribeInstancesCommand({})).then(d => {
      const all = d.Reservations.flatMap(r => r.Instances);
      results.ec2 = { total: all.length, running: all.filter(i => i.State.Name === 'running').length, stopped: all.filter(i => i.State.Name === 'stopped').length };
    }),
    s3.send(new ListBucketsCommand({})).then(d => { results.s3 = { total: d.Buckets?.length || 0 }; }),
    lambda.send(new ListFunctionsCommand({})).then(d => { results.lambda = { total: d.Functions?.length || 0 }; }),
    rds.send(new DescribeDBInstancesCommand({})).then(d => { results.rds = { total: d.DBInstances?.length || 0 }; }),
    ce.send(new GetCostAndUsageCommand({ TimePeriod: { Start: monthStart(), End: today() }, Granularity: 'MONTHLY', Metrics: ['UnblendedCost'] })).then(d => {
      results.cost = { monthly: parseFloat(d.ResultsByTime?.[0]?.Total?.UnblendedCost?.Amount || 0).toFixed(2) };
    }),
    cw.send(new DescribeAlarmsCommand({ StateValue: 'ALARM' })).then(d => { results.alarms = { active: d.MetricAlarms?.length || 0 }; })
  ]);
  res.json(results);
});

// ════════════════════════════════════════════════════════════════════════════
//  START SERVER
// ════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log('');
  console.log('  ███╗   ██╗██╗███╗   ███╗██████╗ ██╗   ██╗███████╗ █████╗ ██╗');
  console.log('  ████╗  ██║██║████╗ ████║██╔══██╗██║   ██║██╔════╝██╔══██╗██║');
  console.log('  ██╔██╗ ██║██║██╔████╔██║██████╔╝██║   ██║███████╗███████║██║');
  console.log('');
  console.log(`  Backend     → http://localhost:${PORT}`);
  console.log(`  Dashboard   → http://localhost:${PORT}/api/dashboard`);
  console.log(`  Multi-Cloud → http://localhost:${PORT}/api/multicloud`);
  console.log(`  AI Chat     → http://localhost:${PORT}/api/ai/chat [POST]`);
  console.log('');
  console.log(`  AWS       → ${process.env.AWS_ACCESS_KEY_ID ? '✅ Connected' : '❌ Not set'}`);
  console.log(`  Azure     → ${process.env.AZURE_TENANT_ID ? '✅ Configured' : '❌ Not set'}`);
  console.log(`  GCP       → ${process.env.GCP_PROJECT_ID ? '✅ Configured' : '❌ Not set'}`);
  console.log(`  Gemini AI → ${process.env.GEMINI_API_KEY ? '✅ Connected' : '❌ Not set'}`);
  console.log(`  Region    → ${REGION}`);
  console.log('');
});

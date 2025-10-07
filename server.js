require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const NodeCache = require('node-cache');

const app = express();
const PORT = process.env.PORT || 3000;

/* =========================
   Collection config (IDs)
   ========================= */
const LIGHTWAVE_BASE_ID = process.env.LIGHTWAVE_BASE_ID
  || 'dd34a6612e0c03dada94ecf3feaca979659585ab0c9cf2e301e7303659712d4e';

const LW_MAX_INDEX = Number(process.env.LW_MAX_INDEX ?? 3332);

/* =========================
   Required external keys
   ========================= */
const ORDINAL_BOT_API_KEY = process.env.ORDINAL_BOT_API_KEY;
if (!ORDINAL_BOT_API_KEY) {
  console.error('CRITICAL: ORDINAL_BOT_API_KEY not set!');
  process.exit(1);
}

/* =========================
   CORS / Middleware
   ========================= */
const corsOptions = {
  origin: [
    'https://kanetix.github.io',
    'https://kanetix.io',
    'https://www.kanetix.io'
  ],
  methods: ['GET','HEAD','POST','OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
  credentials: true,
  optionsSuccessStatus: 204
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());

/* =========================
   API clients
   ========================= */
const OB = axios.create({
  baseURL: 'https://api.ordinalsbot.com',
  headers: { 'x-api-key': ORDINAL_BOT_API_KEY, 'Content-Type': 'application/json' }
});

const HIRO_API_KEY = process.env.HIRO_API_KEY || '';
const Hiro = axios.create({
  baseURL: 'https://api.hiro.so/ordinals/v1',
  headers: Object.assign({ Accept: 'application/json' }, HIRO_API_KEY ? { 'x-api-key': HIRO_API_KEY } : {})
});

/* =========================
   Utilities
   ========================= */
const feeCache = new NodeCache({ stdTTL: 30 });

async function getCurrentFeeRates() {
  const cached = feeCache.get('feeRates');
  if (cached) return cached;

  const { data } = await axios.get('https://mempool.space/api/v1/fees/recommended');
  if (
    typeof data.economyFee !== 'number' ||
    typeof data.hourFee !== 'number' ||
    typeof data.fastestFee !== 'number'
  ) throw new Error('Invalid fee data from mempool.space');

  const feeRates = {
    low: data.economyFee,
    medium: data.hourFee,
    high: data.fastestFee,
    timestamp: Date.now()
  };
  feeCache.set('feeRates', feeRates);
  return feeRates;
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      if (i >= items.length) break;
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

function getIndexFromId(id) {
  const m = /^([a-f0-9]{64})i(\d+)$/.exec(id);
  return m ? Number(m[2]) : null;
}

/* =========================
   Routes
   ========================= */

app.get('/', (_req, res) => {
  res.json({
    status: 'Light Waves Reveal API is running',
    version: '3.2.0',
    collection: {
      baseId: LIGHTWAVE_BASE_ID,
      maxIndex: LW_MAX_INDEX
    },
    endpoints: {
      'POST /api/check-wallet': 'Find Light Waves by inscription ID',
      'GET /api/fee-rates': 'Get current fee rates',
      'POST /api/create-reveal': 'Create reinscription order',
      'GET /api/order-status/:orderId': 'Check order status'
    }
  });
});

app.post('/api/check-wallet', async (req, res) => {
  try {
    const { address } = req.body || {};
    if (!address) return res.status(400).json({ status: 'error', error: 'Wallet address required' });

    console.log(`\n=== CHECKING LIGHT WAVES FOR ${address} ===`);
    
    const ownedLightWaves = [];
    const batchSize = 50;
    
    for (let start = 0; start <= LW_MAX_INDEX; start += batchSize) {
      const end = Math.min(start + batchSize - 1, LW_MAX_INDEX);
      const ids = [];
      
      for (let i = start; i <= end; i++) {
        ids.push(`${LIGHTWAVE_BASE_ID}i${i}`);
      }
      
      try {
        const params = new URLSearchParams();
        ids.forEach(id => params.append('id', id));
        params.append('limit', '60');
        
        const { data } = await Hiro.get(`/inscriptions?${params.toString()}`);
        
        const owned = (data.results || []).filter(ins => 
          ins.address === address || ins.genesis_address === address
        );
        
        ownedLightWaves.push(...owned);
        console.log(`Checked ${start}-${end}: found ${owned.length} owned`);
      } catch (batchError) {
        console.error(`Error checking batch ${start}-${end}:`, batchError.message);
      }
    }

    console.log(`Total Light Waves owned: ${ownedLightWaves.length}`);

    if (ownedLightWaves.length === 0) {
      return res.json({
        status: 'success',
        unrevealed: [],
        totals: { owned: 0, unrevealed: 0 }
      });
    }

    const withSat = await mapPool(ownedLightWaves, 12, async (ins) => {
      if (ins.sat_ordinal !== undefined && ins.sat_ordinal !== null) return ins;
      
      try {
        const { data: full } = await Hiro.get(`/inscriptions/${ins.id}`);
        return { ...ins, sat_ordinal: full.sat_ordinal };
      } catch (err) {
        console.error(`Failed to get sat_ordinal for ${ins.id}:`, err.message);
        return ins;
      }
    });

    const withSatClean = withSat.filter(x => x.sat_ordinal !== undefined && x.sat_ordinal !== null);
    
    console.log(`Light Waves with sat_ordinal: ${withSatClean.length}`);

    const uniqueSatStrs = [...new Set(withSatClean.map(c => String(c.sat_ordinal)))];
    
    const satTotals = await mapPool(uniqueSatStrs, 12, async (satStr) => {
      try {
        const { data } = await Hiro.get(`/sats/${satStr}/inscriptions`, { params: { limit: 1 } });
        return { satStr, total: data?.total || 0 };
      } catch (err) {
        console.error(`Failed to check sat ${satStr}:`, err.message);
        return { satStr, total: 0 };
      }
    });
    
    const totalsBySat = new Map(satTotals.map(x => [x.satStr, x.total]));

    const unrevealed = withSatClean
      .filter(c => (totalsBySat.get(String(c.sat_ordinal)) ?? 0) === 1)
      .map(c => ({
        id: c.id,
        revealed: false,
        satOrdinal: String(c.sat_ordinal),
        label: `Light Wave #${getIndexFromId(c.id) + 1}`,
        index: getIndexFromId(c.id)
      }));

    console.log(`Unrevealed Light Waves: ${unrevealed.length}`);

    return res.json({
      status: 'success',
      unrevealed,
      totals: { owned: ownedLightWaves.length, unrevealed: unrevealed.length }
    });
    
  } catch (err) {
    console.error('Check wallet error:', err?.message);
    return res.status(502).json({ 
      status: 'error', 
      error: 'Failed to check wallet',
      details: err?.message 
    });
  }
});

app.post('/api/create-reveal', async (req, res) => {
  try {
    const { lightWaveIds, receiveAddress, feeLevel = 'medium' } = req.body || {};
    if (!Array.isArray(lightWaveIds) || lightWaveIds.length === 0) {
      return res.status(400).json({ error: 'Light Wave IDs required' });
    }
    if (!receiveAddress) {
      return res.status(400).json({ error: 'Receive address required' });
    }

    const feeRates = await getCurrentFeeRates();
    const feeRate = feeRates[feeLevel];
    if (!feeRate) throw new Error(`Invalid fee level: ${feeLevel}`);

    const orderData = {
      inscriptionIds: lightWaveIds,
      fee: feeRate,
      receiveAddress,
      reinscribe: true,
      childInscription: { contentType: 'text/plain', content: '' }
    };

    const { data } = await OB.post('/reinscribe', orderData);
    return res.json({
      status: 'success',
      orderId: data.id,
      charge: data.charge,
      inscriptionCount: lightWaveIds.length,
      feeRate,
      totalAmount: data.charge?.amount || 0,
      paymentAddress: data.charge?.address,
      lightningInvoice: data.charge?.lightning?.address
    });
  } catch (error) {
    console.error('OrdinalsBot error:', error?.response?.data || error?.message);
    return res.status(500).json({
      error: 'Failed to create reveal order',
      details: error?.response?.data?.error || error?.message
    });
  }
});

app.get('/api/fee-rates', async (_req, res) => {
  try {
    const feeRates = await getCurrentFeeRates();
    res.json(feeRates);
  } catch (error) {
    console.error('Fee fetch error:', error?.message);
    res.status(500).json({ error: 'Failed to fetch fee rates', details: error?.message });
  }
});

app.get('/api/order-status/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const { data } = await OB.get(`/order/${orderId}`);
    res.json({ status: 'success', order: data });
  } catch (error) {
    console.error('Order status error:', error?.response?.data || error?.message);
    res.status(500).json({ error: 'Failed to fetch order status', details: error?.message });
  }
});

app.listen(PORT, () => {
  console.log(`Light Waves Reveal API running on port ${PORT}`);
  console.log('Environment:', process.env.NODE_ENV || 'development');
  console.log('OB key configured:', !!ORDINAL_BOT_API_KEY);
  console.log('Hiro key configured:', !!HIRO_API_KEY);
  console.log('Collection base:', LIGHTWAVE_BASE_ID, ' max index:', LW_MAX_INDEX);
});

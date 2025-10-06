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
// Base inscription txid (NO trailing 'i')
const LIGHTWAVE_BASE_ID = process.env.LIGHTWAVE_BASE_ID
  || 'dd34a6612e0c03dada94ecf3feaca979659585ab0c9cf2e301e7303659712d4ei';

// Max index in your collection (0..LW_MAX_INDEX inclusive)
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
const feeCache = new NodeCache({ stdTTL: 30 }); // 30s mempool cache

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

// Concurrency helper
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

// Does an inscription ID belong to our collection? (base txid + 'i<index>')
function isOurInscriptionId(id) {
  const m = /^([a-f0-9]{64})i(\d+)$/.exec(id);
  if (!m) return false;
  if (m[1] !== LIGHTWAVE_BASE_ID) return false;
  const idx = Number(m[2]);
  return Number.isInteger(idx) && idx >= 0 && idx <= LW_MAX_INDEX;
}

// Optional: extract index for debugging/telemetry
function getIndexFromId(id) {
  const m = /^([a-f0-9]{64})i(\d+)$/.exec(id);
  return m ? Number(m[2]) : null;
}

/* =========================
   Routes
   ========================= */

// Health
app.get('/', (_req, res) => {
  res.json({
    status: 'Light Waves Reveal API is running',
    version: '3.1.0',
    collection: {
      baseId: LIGHTWAVE_BASE_ID,
      maxIndex: LW_MAX_INDEX
    },
    endpoints: {
      'POST /api/check-wallet': 'Classify wallet holdings (Hiro) using inscription ID pattern',
      'GET /api/fee-rates': 'Get current fee rates (mempool.space)',
      'POST /api/create-reveal': 'Create reinscription order (OrdinalsBot)',
      'GET /api/order-status/:orderId': 'Check order status (OrdinalsBot)'
    }
  });
});

/**
 * POST /api/check-wallet
 * body: { address: string }
 *
 * Steps:
 *  1) List wallet inscriptions via Hiro (paged)
 *  2) Keep only IDs matching `${LIGHTWAVE_BASE_ID}i<0..LW_MAX_INDEX>`
 *  3) Ensure sat_ordinal for each (from list or `/inscriptions/{id}`)
 *  4) For each unique sat: `/sats/{sat}/inscriptions?limit=1` → read `total`
 *  5) UNREVEALED if `total === 1`
 */
/**
 * POST /api/check-wallet
 * body: { address: string }
 */
app.post('/api/check-wallet', async (req, res) => {
  try {
    const { address } = req.body || {};
    if (!address) return res.status(400).json({ status: 'error', error: 'Wallet address required' });

    // 1) list wallet inscriptions
    const perPage = 60;
    let offset = 0;
    const owned = [];
    while (true) {
      const { data: page } = await Hiro.get('/inscriptions', {
        params: { address, limit: perPage, offset }
      });
      const results = page?.results || [];
      owned.push(...results);
      offset += perPage;
      if (owned.length >= (page?.total || 0)) break;
    }

    // 🔍 CRITICAL DEBUG: Check if any IDs contain your base txid
    console.log(`\n=== CHECKING ${owned.length} INSCRIPTIONS ===`);
    const containsBase = owned.filter(ins => 
      ins.id && ins.id.includes('dd34a6612e0c03dada94ecf3feaca979659585ab0c9cf2e301e7303659712d4e')
    );
    console.log(`Found ${containsBase.length} inscriptions containing base txid`);
    
    if (containsBase.length > 0) {
      console.log('First 5 matching IDs:');
      containsBase.slice(0, 5).forEach(ins => console.log(`  ${ins.id}`));
    } else {
      console.log('First 10 IDs in wallet:');
      owned.slice(0, 10).forEach(ins => console.log(`  ${ins.id}`));
    }
    console.log('=====================================\n');

    // 2) filter to our collection by ID pattern
    const mine = owned.filter(r => r?.id && isOurInscriptionId(r.id));
    if (mine.length === 0) {
      return res.json({
        status: 'success',
        unrevealed: [],
        totals: { owned: owned.length, inRange: 0, unrevealed: 0 }
      });
    }

    // 3) ensure sat_ordinal
    const withSat = await mapPool(mine, 12, async (ins) => {
      if (ins.sat_ordinal !== undefined && ins.sat_ordinal !== null) return ins;
      const { data: full } = await Hiro.get(`/inscriptions/${ins.id}`);
      return { ...ins, sat_ordinal: full.sat_ordinal };
    });

    const withSatClean = withSat.filter(x => x.sat_ordinal !== undefined && x.sat_ordinal !== null);

    // 4) unique sat → get total inscription count on that sat
    const uniqueSatStrs = [...new Set(withSatClean.map(c => String(c.sat_ordinal)))].filter(Boolean);
    const satTotals = await mapPool(uniqueSatStrs, 12, async (satStr) => {
      const { data } = await Hiro.get(`/sats/${satStr}/inscriptions`, { params: { limit: 1, offset: 0 } });
      return { satStr, total: data?.total || 0 };
    });
    const totalsBySat = new Map(satTotals.map(x => [x.satStr, x.total]));

    // 5) unrevealed = sat has exactly 1 inscription
    const unrevealed = withSatClean
      .filter(c => (totalsBySat.get(String(c.sat_ordinal)) ?? 0) === 1)
      .map(c => ({
        id: c.id,
        revealed: false,
        satOrdinal: String(c.sat_ordinal),
        label: `Sat ${String(c.sat_ordinal)}`,
        index: getIndexFromId(c.id)
      }));

    return res.json({
      status: 'success',
      unrevealed,
      totals: { owned: owned.length, inRange: withSatClean.length, unrevealed: unrevealed.length }
    });
  } catch (err) {
    console.error('Hiro check failure:', err?.response?.status, err?.response?.data || err?.message);
    return res.status(502).json({ status: 'error', error: 'Hiro API failed', details: err?.message || String(err) });
  }
});

/**
 * POST /api/create-reveal
 * body: { lightWaveIds: string[], receiveAddress: string, feeLevel: 'low'|'medium'|'high' }
 * Reinscribes a blank text child on each target inscription (your reveal mechanism).
 */
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

// Fees passthrough
app.get('/api/fee-rates', async (_req, res) => {
  try {
    const feeRates = await getCurrentFeeRates();
    res.json(feeRates);
  } catch (error) {
    console.error('Fee fetch error:', error?.message);
    res.status(500).json({ error: 'Failed to fetch fee rates', details: error?.message });
  }
});

// OB order status
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




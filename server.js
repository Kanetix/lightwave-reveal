require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const NodeCache = require('node-cache');

const app = express();
const PORT = process.env.PORT || 3000;

// Cache for fee rates (updates every 30 seconds)
const feeCache = new NodeCache({ stdTTL: 30 });

// Middleware - CLEANED UP ORIGINS
app.use(cors({
  origin: [
    'https://kanetix.github.io',
    'https://kanetix.io',
    'https://www.kanetix.io'
  ],
  credentials: true
}));
app.use(express.json());

// CORRECTED: Light Waves base ID (without the 'i' at the end)
const LIGHTWAVE_BASE_ID = 'dd34a6612e0c03dada94ecf3feaca979659585ab0c9cf2e301e7303659712d4e';
const ORDINAL_BOT_API_KEY = process.env.ORDINAL_BOT_API_KEY;
const ORDINAL_BOT_API_URL = 'https://api.ordinalsbot.com';

// Use standard endpoints for ordinals.com
const ORDINALS_API_URL = 'https://ordinals.com';

// Helper function to check inscription
async function checkInscriptionExists(inscriptionId) {
  try {
    const response = await axios.get(`${ORDINALS_API_URL}/inscription/${inscriptionId}`);
    
    // Parse the HTML response to extract data
    const html = response.data;
    
    // Extract owner address from HTML
    const addressMatch = html.match(/<a href="\/address\/([^"]+)">/);
    const address = addressMatch ? addressMatch[1] : null;
    
    // Extract sat number
    const satMatch = html.match(/<a href="\/sat\/(\d+)">/);
    const sat = satMatch ? satMatch[1] : null;
    
    return {
      id: inscriptionId,
      address: address,
      sat: sat,
      exists: true
    };
  } catch (error) {
    if (error.response && error.response.status === 404) {
      return null;
    }
    console.error(`Error checking inscription ${inscriptionId}:`, error.message);
    throw error;
  }
}

// Helper function to get sat info
async function getSatInfo(satNumber) {
  try {
    const response = await axios.get(`${ORDINALS_API_URL}/sat/${satNumber}`);
    const html = response.data;
    
    // Extract inscription IDs from the sat page
    const inscriptionMatches = html.matchAll(/<a href="\/inscription\/([a-f0-9]{64}i\d+)">/g);
    const ids = Array.from(inscriptionMatches, m => m[1]);
    
    return {
      sat: satNumber,
      ids: ids
    };
  } catch (error) {
    console.error(`Error fetching sat info for ${satNumber}:`, error.message);
    throw error;
  }
}

// Check if a Light Wave is revealed (has reinscription)
async function checkIfRevealed(inscriptionId) {
  try {
    const inscription = await checkInscriptionExists(inscriptionId);
    if (!inscription || !inscription.sat) {
      return { exists: false, inscriptionId };
    }

    const satInfo = await getSatInfo(inscription.sat);
    
    // Light Wave is revealed if the sat has more than 1 inscription
    const isRevealed = satInfo.ids && satInfo.ids.length > 1;
    
    return {
      exists: true,
      revealed: isRevealed,
      inscriptionId,
      owner: inscription.address,
      sat: inscription.sat,
      inscriptionCount: satInfo.ids ? satInfo.ids.length : 1,
      inscriptions: satInfo.ids || [inscriptionId]
    };
  } catch (error) {
    console.error(`Error checking reveal status for ${inscriptionId}:`, error.message);
    throw error; // NO FALLBACK - let it fail
  }
}

// Get current fee rates from mempool.space - NO FALLBACK
async function getCurrentFeeRates() {
  // Check cache first
  const cached = feeCache.get('feeRates');
  if (cached) {
    return cached;
  }

  // Fetch from mempool.space API
  const response = await axios.get('https://mempool.space/api/v1/fees/recommended');
  
  if (!response.data.economyFee || !response.data.hourFee || !response.data.fastestFee) {
    throw new Error('Invalid fee data from mempool.space');
  }
  
  const feeRates = {
    low: response.data.economyFee,
    medium: response.data.hourFee,
    high: response.data.fastestFee,
    timestamp: Date.now()
  };

  // Cache the rates
  feeCache.set('feeRates', feeRates);
  return feeRates;
}

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'Light Waves Reveal API is running',
    version: '2.0.0',
    endpoints: {
      'POST /api/check-wallet': 'Check wallet for Light Waves',
      'GET /api/fee-rates': 'Get current fee rates',
      'POST /api/create-reveal': 'Create reveal order',
      'GET /api/order-status/:orderId': 'Check order status'
    }
  });
});

// Check wallet for Light Waves
app.post('/api/check-wallet', async (req, res) => {
  try {
    const { address, startIndex = 0, endIndex = 100 } = req.body;
    
    if (!address) {
      return res.status(400).json({ error: 'Wallet address required' });
    }

    console.log(`Checking Light Waves for address: ${address}`);
    console.log(`Range: ${startIndex} to ${endIndex}`);

    const lightWaves = [];
    const checkPromises = [];
    const BATCH_SIZE = 10;

    for (let i = startIndex; i < Math.min(endIndex, 3333); i += BATCH_SIZE) {
      const batchEnd = Math.min(i + BATCH_SIZE, endIndex);
      
      for (let j = i; j < batchEnd; j++) {
        // CORRECTED FORMAT: base_id + 'i' + number
        const inscriptionId = `${LIGHTWAVE_BASE_ID}i${j}`;
        
        checkPromises.push(
          checkInscriptionExists(inscriptionId).then(async (inscription) => {
            if (inscription && inscription.address === address) {
              const revealStatus = await checkIfRevealed(inscriptionId);
              return {
                id: inscriptionId,
                number: j,
                revealed: revealStatus.revealed || false,
                sat: inscription.sat,
                owner: inscription.address
              };
            }
            return null;
          }).catch(err => {
            console.error(`Error checking #${j}:`, err.message);
            throw err; // NO FALLBACK - let it fail
          })
        );
      }
      
      if (checkPromises.length >= BATCH_SIZE) {
        const batchResults = await Promise.all(checkPromises);
        const validResults = batchResults.filter(lw => lw !== null);
        lightWaves.push(...validResults);
        checkPromises.length = 0;
        
        // Small delay between batches
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    if (checkPromises.length > 0) {
      const finalResults = await Promise.all(checkPromises);
      const validResults = finalResults.filter(lw => lw !== null);
      lightWaves.push(...validResults);
    }

    const unrevealed = lightWaves.filter(lw => !lw.revealed);
    const revealed = lightWaves.filter(lw => lw.revealed);

    console.log(`Found ${lightWaves.length} Light Waves (${unrevealed.length} unrevealed)`);

    res.json({
      status: 'success',
      address,
      lightWaves,
      unrevealed,
      revealed,
      unrevealedCount: unrevealed.length,
      revealedCount: revealed.length,
      checkedRange: { start: startIndex, end: endIndex }
    });

  } catch (error) {
    console.error('Error checking wallet:', error);
    res.status(500).json({ 
      error: 'Failed to check wallet',
      details: error.message 
    });
  }
});

// Create reveal order (reinscription) - CORRECTED FOR ORDINALSBOT API
app.post('/api/create-reveal', async (req, res) => {
  try {
    const { lightWaveIds, receiveAddress, feeLevel = 'medium' } = req.body;

    if (!lightWaveIds || !Array.isArray(lightWaveIds) || lightWaveIds.length === 0) {
      return res.status(400).json({ error: 'Light Wave IDs required' });
    }

    if (!receiveAddress) {
      return res.status(400).json({ error: 'Receive address required' });
    }

    if (!ORDINAL_BOT_API_KEY) {
      throw new Error('Server configuration error: API key not set');
    }

    // Get current fee rates - NO FALLBACK
    const feeRates = await getCurrentFeeRates();
    const feeRate = feeRates[feeLevel];
    
    if (!feeRate) {
      throw new Error(`Invalid fee level: ${feeLevel}`);
    }

    console.log(`Creating reveal order for ${lightWaveIds.length} Light Waves at ${feeRate} sat/vB`);

    // CORRECTED: Use proper reinscribe endpoint and structure
    const orderData = {
      inscriptionIds: lightWaveIds,
      fee: feeRate,
      receiveAddress: receiveAddress,
      // For reveals, we're adding an empty child inscription
      reinscribe: true,
      childInscription: {
        contentType: 'text/plain',
        content: '' // Empty content for reveal
      }
    };

    // Use the reinscribe endpoint
    const response = await axios.post(
      `${ORDINAL_BOT_API_URL}/reinscribe`,
      orderData,
      {
        headers: {
          'x-api-key': ORDINAL_BOT_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('OrdinalsBot response:', response.data);

    res.json({
      status: 'success',
      orderId: response.data.id,
      charge: response.data.charge,
      inscriptionCount: lightWaveIds.length,
      feeRate: feeRate,
      totalAmount: response.data.charge?.amount || 0,
      paymentAddress: response.data.charge?.address,
      lightningInvoice: response.data.charge?.lightning?.address
    });

  } catch (error) {
    console.error('Error creating reveal order:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to create reveal order',
      details: error.response?.data?.error || error.message 
    });
  }
});

// Get current fee rates - NO FALLBACK
app.get('/api/fee-rates', async (req, res) => {
  try {
    const feeRates = await getCurrentFeeRates();
    res.json(feeRates);
  } catch (error) {
    console.error('Error fetching fee rates:', error);
    res.status(500).json({ 
      error: 'Failed to fetch fee rates',
      details: error.message 
    });
  }
});

// Get order status
app.get('/api/order-status/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;

    if (!ORDINAL_BOT_API_KEY) {
      throw new Error('Server configuration error');
    }

    const response = await axios.get(
      `${ORDINAL_BOT_API_URL}/order/${orderId}`,
      {
        headers: {
          'x-api-key': ORDINAL_BOT_API_KEY
        }
      }
    );

    res.json({
      status: 'success',
      order: response.data
    });

  } catch (error) {
    console.error('Error fetching order status:', error);
    res.status(500).json({ 
      error: 'Failed to fetch order status',
      details: error.message 
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Light Waves Reveal API running on port ${PORT}`);
  console.log('Environment:', process.env.NODE_ENV);
  console.log('API Key configured:', !!ORDINAL_BOT_API_KEY);
  
  if (!ORDINAL_BOT_API_KEY) {
    console.error('CRITICAL ERROR: ORDINAL_BOT_API_KEY not set in environment variables!');
    process.exit(1); // Exit if no API key
  }
});
Claude
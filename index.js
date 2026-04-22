const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.post('/api/message', async (req, res) => {
  if (!API_KEY) {
    console.error('ERROR: ANTHROPIC_API_KEY environment variable is not set');
    return res.status(500).json({ error: 'API key not configured on server.' });
  }

  console.log('Received request, forwarding to Anthropic...');

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });

    const rawText = await response.text();
    console.log('Anthropic response status:', response.status);
    console.log('Anthropic raw response:', rawText.substring(0, 500));

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (parseErr) {
      console.error('Failed to parse response:', rawText);
      return res.status(500).json({ error: 'Invalid response from Anthropic: ' + rawText.substring(0, 200) });
    }

    res.status(response.status).json(data);

  } catch (err) {
    console.error('Fetch error:', err.message);
    res.status(500).json({ error: 'Proxy fetch error: ' + err.message });
  }
});

app.get('/', (req, res) => {
  res.json({ 
    status: 'P3 Services API Proxy is running.',
    apiKeySet: !!API_KEY
  });
});

app.listen(PORT, () => {
  console.log('Proxy server running on port ' + PORT);
  console.log('API Key configured:', !!API_KEY);
});

const https = require('https');

const FIREBASE_URL = 'maple-holdings-group-default-rtdb.firebaseio.com';

function firebaseRequest(method, path, data) {
  return new Promise((resolve, reject) => {
    const body = data ? JSON.stringify(data) : null;
    const options = {
      hostname: FIREBASE_URL,
      path: `${path}.json${process.env.FIREBASE_SECRET ? '?auth=' + process.env.FIREBASE_SECRET : ''}`,
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => { try { resolve(JSON.parse(d || 'null')); } catch(e) { resolve(null); } });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function quoSend(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const options = {
      hostname: 'api.openphone.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Authorization': process.env.OPENPHONE_API_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(d || '{}'); } catch(e) { parsed = { raw: d }; }
        resolve({ statusCode: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function cleanPhone(phone) {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  if (phone.startsWith('+')) return phone;
  return '+' + digits;
}

const FROM_NUMBERS = {
  Alon: process.env.OPENPHONE_FROM_ALON,
  Niv: process.env.OPENPHONE_FROM_NIV
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { to, text, sender, brokerId } = req.body || {};

    if (!to || !text || !sender) {
      return res.status(400).json({ error: 'Missing required fields: to, text, sender' });
    }

    const fromNumber = FROM_NUMBERS[sender];
    if (!fromNumber) {
      return res.status(400).json({ error: `No "from" number configured for sender: ${sender}` });
    }

    const toFormatted = cleanPhone(to);

    const quoResult = await quoSend({
      content: text,
      from: fromNumber,
      to: [toFormatted]
    });

    if (quoResult.statusCode < 200 || quoResult.statusCode >= 300) {
      console.error('Quo send failed:', quoResult.statusCode, JSON.stringify(quoResult.body));
      return res.status(502).json({
        error: 'Failed to send message',
        quoStatus: quoResult.statusCode,
        quoResponse: quoResult.body
      });
    }

    let resolvedBrokerId = brokerId;
    if (!resolvedBrokerId) {
      const brokers = await firebaseRequest('GET', '/brokers') || {};
      const cleanTarget = cleanPhone(to).replace(/\D/g, '');
      for (const [id, broker] of Object.entries(brokers)) {
        if (!broker.phone) continue;
        const brokerClean = cleanPhone(broker.phone).replace(/\D/g, '');
        if (brokerClean === cleanTarget) { resolvedBrokerId = id; break; }
      }
    }

    if (resolvedBrokerId) {
      const noteId = generateId();
      const properties = await firebaseRequest('GET', '/properties');
      const linkedPropertyIds = [];
      if (properties) {
        for (const [pid, prop] of Object.entries(properties)) {
          if (prop.brokerId === resolvedBrokerId) linkedPropertyIds.push(pid);
        }
      }
      const note = {
        id: noteId, brokerId: resolvedBrokerId,
        type: 'sms', direction: 'outgoing',
        phone: toFormatted, text, smsBody: text,
        createdBy: sender, createdById: sender.toLowerCase(),
        createdAt: Date.now(), readBy: {}
      };
      if (linkedPropertyIds.length > 0) note.propertyIds = linkedPropertyIds;
      await firebaseRequest('PUT', `/notes/${noteId}`, note);
      return res.status(200).json({ success: true, noteId, brokerId: resolvedBrokerId });
    }

    return res.status(200).json({ success: true, warning: 'Message sent but no matching broker found to log note' });

  } catch (err) {
    console.error('send-message error:', err);
    return res.status(500).json({ error: err.message });
  }
};

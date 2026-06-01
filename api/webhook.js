const https = require('https');

const FIREBASE_URL = 'maple-holdings-group-default-rtdb.firebaseio.com';
const OPENPHONE_API_KEY = process.env.OPENPHONE_API_KEY;

function firebaseRequest(method, path, data) {
  return new Promise((resolve, reject) => {
    const body = data ? JSON.stringify(data) : null;
    const options = {
      hostname: FIREBASE_URL,
      path: `${path}.json`,
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => resolve(JSON.parse(d || 'null')));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function formatDuration(seconds) {
  if (!seconds) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function matchBrokerByPhone(brokers, phoneNumber) {
  if (!brokers || !phoneNumber) return null;
  const clean = phoneNumber.replace(/\D/g, '');
  for (const [id, broker] of Object.entries(brokers)) {
    if (!broker.phone) continue;
    const brokerClean = broker.phone.replace(/\D/g, '');
    if (brokerClean === clean || brokerClean.endsWith(clean) || clean.endsWith(brokerClean)) {
      return { id, ...broker };
    }
  }
  return null;
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const event = req.body;
    const type = event?.type;
    const data = event?.data?.object;

    if (!type || !data) return res.status(400).json({ error: 'Invalid payload' });

    const brokers = await firebaseRequest('GET', '/brokers');

    let note = null;

    // ── Inbound call completed
    if (type === 'call.completed') {
      const from = data.from;
      const direction = data.direction;
      const duration = data.duration;
      const broker = matchBrokerByPhone(brokers, direction === 'incoming' ? from : data.to);

      if (broker) {
        note = {
          id: generateId(),
          brokerId: broker.id,
          type: 'call',
          direction,
          duration: formatDuration(duration),
          durationSeconds: duration || 0,
          phone: from,
          text: direction === 'incoming'
            ? `Incoming call · ${formatDuration(duration) || 'no duration'}`
            : `Outgoing call · ${formatDuration(duration) || 'no duration'}`,
          createdBy: 'OpenPhone',
          createdById: 'openphone',
          createdAt: Date.now(),
          readBy: {}
        };
      }
    }

    // ── Missed call
    if (type === 'call.missed') {
      const from = data.from;
      const broker = matchBrokerByPhone(brokers, from);
      if (broker) {
        note = {
          id: generateId(),
          brokerId: broker.id,
          type: 'call_missed',
          direction: 'incoming',
          phone: from,
          text: 'Missed call',
          createdBy: 'OpenPhone',
          createdById: 'openphone',
          createdAt: Date.now(),
          readBy: {}
        };
      }
    }

    // ── SMS received or sent
    if (type === 'message.received' || type === 'message.delivered') {
      const from = data.from;
      const to = data.to?.[0];
      const body = data.body || '';
      const direction = type === 'message.received' ? 'incoming' : 'outgoing';
      const broker = matchBrokerByPhone(brokers, direction === 'incoming' ? from : to);

      if (broker) {
        note = {
          id: generateId(),
          brokerId: broker.id,
          type: 'sms',
          direction,
          phone: direction === 'incoming' ? from : to,
          text: body,
          smsBody: body,
          createdBy: 'OpenPhone',
          createdById: 'openphone',
          createdAt: Date.now(),
          readBy: {}
        };
      }
    }

    if (note) {
      await firebaseRequest('PUT', `/notes/${note.id}`, note);
      return res.status(200).json({ success: true, noteId: note.id, brokerId: note.brokerId });
    }

    return res.status(200).json({ success: true, skipped: true, reason: 'No matching broker or unhandled event' });

  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(500).json({ error: err.message });
  }
};

const https = require('https');

const FIREBASE_URL = 'maple-holdings-group-default-rtdb.firebaseio.com';

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
      res.on('end', () => { try { resolve(JSON.parse(d || 'null')); } catch(e) { resolve(null); } });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function quoRequest(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.openphone.com',
      path,
      method: 'GET',
      headers: {
        'Authorization': process.env.OPENPHONE_API_KEY,
        'Content-Type': 'application/json'
      }
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch(e) { resolve({}); } });
    });
    req.on('error', reject);
    req.end();
  });
}

function formatDuration(seconds) {
  if (!seconds) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function cleanPhone(phone) {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

function matchBrokerByPhone(brokers, phoneNumber) {
  if (!brokers || !phoneNumber) return null;
  const clean = cleanPhone(phoneNumber);
  if (clean.length < 7) return null;
  for (const [id, broker] of Object.entries(brokers)) {
    if (!broker.phone) continue;
    const brokerClean = cleanPhone(broker.phone);
    if (brokerClean.length < 7) continue;
    if (brokerClean === clean) return { id, ...broker };
  }
  return null;
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// ── One-time import of all Quo contacts ──────────────────────
async function runQuoImport() {
  try {
    console.log('Starting Quo contacts import...');
    // Set flag immediately to prevent duplicate runs
    await firebaseRequest('PUT', '/meta/quo_import_done', true);

    const brokers = await firebaseRequest('GET', '/brokers') || {};
    let page = null;
    let imported = 0;
    let skipped = 0;

    do {
      const url = '/v1/contacts?maxResults=50' + (page ? `&pageToken=${page}` : '');
      console.log('Fetching:', url);
      const res = await quoRequest(url);
      console.log('Response keys:', Object.keys(res));
      console.log('Full response:', JSON.stringify(res));
      if(res.message||res.errors){console.log('API ERROR:',res.message||JSON.stringify(res.errors));return {imported:0,skipped:0,error:res.message};}
      console.log('Data length:', res.data?.length, 'Total:', res.total);
      const contacts = res.data || [];
      page = res.nextPageToken || null;

      for (const contact of contacts) {
        const name = contact.defaultFields?.firstName ? `${contact.defaultFields.firstName} ${contact.defaultFields.lastName||''}`.trim() : (contact.name || (contact.firstName ? `${contact.firstName} ${contact.lastName||''}`.trim() : null));
        if (!name) { skipped++; continue; }

        // Get first phone number
        const phoneObj = contact.phoneNumbers?.[0];
        const phone = phoneObj?.value || phoneObj?.phoneNumber || '';
        if (!phone) { skipped++; continue; }

        // Check if broker already exists by phone
        const existing = matchBrokerByPhone(brokers, phone);
        if (existing) { skipped++; continue; }

        // Create broker card
        const brokerId = generateId();
        const brokerData = {
          name,
          phone,
          area: '',
          status: 'active',
          addedBy: 'Quo Import',
          createdAt: Date.now()
        };
        await firebaseRequest('PUT', `/brokers/${brokerId}`, brokerData);
        brokers[brokerId] = brokerData;

        // Import notes if any
        if (contact.notes) {
          const noteId = generateId();
          await firebaseRequest('PUT', `/notes/${noteId}`, {
            id: noteId,
            brokerId,
            text: contact.notes,
            createdBy: 'Quo Import',
            createdById: 'openphone',
            createdAt: Date.now(),
            readBy: {}
          });
        }
        imported++;
      }
    } while (page);

    console.log(`Import done: ${imported} imported, ${skipped} skipped`);
    return { imported, skipped };
  } catch (err) {
    console.error('Import error:', err);
    // Reset flag so it can retry
    await firebaseRequest('PUT', '/meta/quo_import_done', false);
    throw err;
  }
}

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Manual import trigger (GET request)
  if (req.method === 'GET' && req.query?.action === 'import') {
    try {
      const result = await runQuoImport();
      return res.status(200).json({ success: true, ...result });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const event = req.body;
    const type = event?.type;
    const data = event?.data?.object;

    if (!type || !data) return res.status(400).json({ error: 'Invalid payload' });

    const brokers = await firebaseRequest('GET', '/brokers') || {};

    // ── contact.updated — ongoing sync (also fires on create)
    if (type === 'contact.updated') {
      const name = data.defaultFields?.firstName ? `${data.defaultFields.firstName} ${data.defaultFields.lastName||''}`.trim() : (data.name || (data.firstName ? `${data.firstName} ${data.lastName||''}`.trim() : null));
      const phone = data.phoneNumbers?.[0]?.value || data.phoneNumbers?.[0]?.phoneNumber || '';
      if (!name || !phone) return res.status(200).json({ success: true, skipped: true, reason: 'No name or phone' });

      // Check for duplicate
      const existing = matchBrokerByPhone(brokers, phone);
      if (existing) return res.status(200).json({ success: true, skipped: true, reason: 'Already exists' });

      const brokerId = generateId();
      const brokerData = {
        name, phone, area: '', status: 'active',
        addedBy: 'Quo', createdAt: Date.now()
      };
      await firebaseRequest('PUT', `/brokers/${brokerId}`, brokerData);

      if (data.notes) {
        const noteId = generateId();
        await firebaseRequest('PUT', `/notes/${noteId}`, {
          id: noteId, brokerId, text: data.notes,
          createdBy: 'Quo', createdById: 'openphone',
          createdAt: Date.now(), readBy: {}
        });
      }
      return res.status(200).json({ success: true, brokerId, action: 'created' });
    }

    // ── call.summary.completed
    if (type === 'call.summary.completed') {
      const callId = data.callId || data.id;
      const summary = data.summary || data.text || '';
      if (!summary || !callId) return res.status(200).json({ success: true, skipped: true });
      const notes = await firebaseRequest('GET', '/notes');
      if (notes) {
        for (const [noteId, note] of Object.entries(notes)) {
          if (note.callId === callId) {
            await firebaseRequest('PATCH', `/notes/${noteId}`, { summary });
            return res.status(200).json({ success: true, updated: noteId });
          }
        }
      }
      return res.status(200).json({ success: true, skipped: true });
    }

    let note = null;

    // ── call.completed
    if (type === 'call.completed') {
      const from = data.from;
      const to = Array.isArray(data.to) ? data.to[0] : data.to;
      const direction = data.direction;
      const callId = data.id;
      let durationSeconds = data.duration || 0;
      if (!durationSeconds && data.answeredAt && data.completedAt) {
        durationSeconds = Math.round((new Date(data.completedAt) - new Date(data.answeredAt)) / 1000);
      }
      const lookupPhone = direction === 'incoming' ? from : to;
      const broker = matchBrokerByPhone(brokers, lookupPhone);
      if (broker) {
        note = {
          id: generateId(), callId, brokerId: broker.id,
          type: 'call', direction,
          duration: formatDuration(durationSeconds),
          durationSeconds,
          phone: from,
          text: direction === 'incoming'
            ? `Incoming call · ${formatDuration(durationSeconds) || 'no duration'}`
            : `Outgoing call · ${formatDuration(durationSeconds) || 'no duration'}`,
          createdBy: 'OpenPhone', createdById: 'openphone',
          createdAt: Date.now(), readBy: {}
        };
      }
    }

    // ── call.missed
    if (type === 'call.missed') {
      const from = data.from;
      const callId = data.id;
      const broker = matchBrokerByPhone(brokers, from);
      if (broker) {
        note = {
          id: generateId(), callId, brokerId: broker.id,
          type: 'call_missed', direction: 'incoming',
          phone: from, text: 'Missed call',
          createdBy: 'OpenPhone', createdById: 'openphone',
          createdAt: Date.now(), readBy: {}
        };
      }
    }

    // ── message.received / message.delivered
    if (type === 'message.received' || type === 'message.delivered') {
      const from = data.from;
      const to = Array.isArray(data.to) ? data.to[0] : data.to;
      const body = data.body || '';
      const direction = type === 'message.received' ? 'incoming' : 'outgoing';
      const lookupPhone = direction === 'incoming' ? from : to;
      const broker = matchBrokerByPhone(brokers, lookupPhone);
      if (broker) {
        note = {
          id: generateId(), brokerId: broker.id,
          type: 'sms', direction,
          phone: lookupPhone, text: body, smsBody: body,
          createdBy: 'OpenPhone', createdById: 'openphone',
          createdAt: Date.now(), readBy: {}
        };
      }
    }

    if (note) {
      const properties = await firebaseRequest('GET', '/properties');
      const linkedPropertyIds = [];
      if (properties) {
        for (const [pid, prop] of Object.entries(properties)) {
          if (prop.brokerId === note.brokerId) linkedPropertyIds.push(pid);
        }
      }
      if (linkedPropertyIds.length > 0) note.propertyIds = linkedPropertyIds;
      await firebaseRequest('PUT', `/notes/${note.id}`, note);
      return res.status(200).json({ success: true, noteId: note.id, brokerId: note.brokerId });
    }

    return res.status(200).json({ success: true, skipped: true, reason: 'No matching broker or unhandled event' });

  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(500).json({ error: err.message });
  }
};

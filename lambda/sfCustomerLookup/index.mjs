import { createSign } from 'node:crypto';

const LOGIN_URL = process.env.SF_LOGIN_URL;
const API_VERSION = process.env.SF_API_VERSION || 'v66.0';
const b64url = (v) => Buffer.from(v).toString('base64url');

let cached = null;   // the token is reused while this Lambda container stays warm

async function getToken() {
  if (cached && cached.expires > Date.now()) { return cached; }
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: process.env.SF_CLIENT_ID,          // Consumer Key
    sub: process.env.SF_USERNAME,           // the user we act as
    aud: LOGIN_URL,                         // must match the login URL exactly
    exp: Math.floor(Date.now() / 1000) + 180
  }));
  const privateKey = Buffer.from(process.env.SF_PRIVATE_KEY_B64, 'base64').toString('utf8');
  const signature = createSign('RSA-SHA256')
    .update(header + '.' + claims)
    .sign(privateKey, 'base64url');

  const res = await fetch(LOGIN_URL + '/services/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: header + '.' + claims + '.' + signature
    })
  });
  if (!res.ok) { throw new Error('Token request failed: ' + res.status + ' ' + (await res.text())); }
  const body = await res.json();
  cached = {
    accessToken: body.access_token,
    instanceUrl: body.instance_url,
    expires: Date.now() + 25 * 60 * 1000
  };
  return cached;
}

async function soql(q, retry = true) {
  const t = await getToken();
  const url = t.instanceUrl + '/services/data/' + API_VERSION + '/query?q=' + encodeURIComponent(q);
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + t.accessToken } });
  if (res.status === 401 && retry) { cached = null; return soql(q, false); }
  if (!res.ok) { throw new Error('Query failed: ' + res.status + ' ' + (await res.text())); }
  return (await res.json()).records;
}

const FIELDS = 'Id, FirstName, (SELECT CaseNumber, Status FROM Cases ORDER BY CreatedDate DESC LIMIT 1)';

export const handler = async (event) => {
  const params = event.Details.Parameters || {};
  const endpoint = event.Details.ContactData.CustomerEndpoint || {};
  const customerNumber = String(params.customerNumber || '').replace(/[^0-9]/g, '');
  const phone = endpoint.Address || '';

  try {
    let records = [];
    if (customerNumber) {
      records = await soql(`SELECT ${FIELDS} FROM Contact WHERE Customer_Number__c = '${customerNumber}' LIMIT 1`);
    } else if (/^\+[0-9]{6,15}$/.test(phone)) {
      records = await soql(`SELECT ${FIELDS} FROM Contact WHERE MobilePhone = '${phone}' OR Phone = '${phone}' LIMIT 1`);
    }
    if (records.length === 0) { return { found: 'false' }; }

    const c = records[0];
    const latest = c.Cases && c.Cases.records && c.Cases.records[0];
    // Amazon Connect needs a flat object of strings
    return {
      found: 'true',
      sfContactId: c.Id,
      firstName: c.FirstName || '',
      caseNumber: latest ? latest.CaseNumber : '',
      caseStatus: latest ? latest.Status : ''
    };
  } catch (err) {
    console.error(err.message);   // log the reason, never the token or the key
    return { found: 'error' };
  }
};
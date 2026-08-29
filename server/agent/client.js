'use strict';
// ============================================================
// Gorz Reborn — agent/client.js (headless agent SDK)
// Tiny Node.js client for the agent HTTP API.
//
// Usage:
//   const GorzAgent = require('./agent/client');
//   const a = new GorzAgent('http://localhost:3000');
//   const agent = await a.register({ name: 'phalanx', lineage: 'sparta' });
//   const pop = await a.population('sparta');
//   const result = await a.duel(agent.id, pop[1].id);
// ============================================================

const http = require('http');
const https = require('https');
const { URL } = require('url');

function requestJson(urlStr, { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json' },
    };
    const req = lib.request(opts, (res) => {
      let chunks = '';
      res.setEncoding('utf8');
      res.on('data', (c) => chunks += c);
      res.on('end', () => {
        try {
          const parsed = chunks ? JSON.parse(chunks) : {};
          if (res.statusCode >= 400) {
            return reject(new Error(`HTTP ${res.statusCode}: ${JSON.stringify(parsed)}`));
          }
          resolve(parsed);
        } catch (e) {
          reject(new Error(`Bad JSON from ${urlStr}: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

class GorzAgent {
  constructor(baseUrl = 'http://localhost:3000') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }
  async register(opts = {}) {
    return (await requestJson(`${this.baseUrl}/api/agent/register`, { method: 'POST', body: opts })).agent;
  }
  async population(lineage = 'sparta', { includeRetired = false, limit = 100 } = {}) {
    const q = new URLSearchParams({ lineage, limit: String(limit), include_retired: includeRetired ? '1' : '0' });
    return (await requestJson(`${this.baseUrl}/api/agent/population?${q}`)).agents;
  }
  async genome(id) {
    return (await requestJson(`${this.baseUrl}/api/agent/genome/${id}`)).genome;
  }
  async duel(agentAId, agentBId, seed) {
    return requestJson(`${this.baseUrl}/api/agent/duel`, { method: 'POST', body: { agentAId, agentBId, seed } });
  }
  async tournament(opts = {}) {
    return requestJson(`${this.baseUrl}/api/agent/tournament`, { method: 'POST', body: opts });
  }
  async lineages() {
    return (await requestJson(`${this.baseUrl}/api/agent/lineages`)).lineages;
  }
  async health() {
    return requestJson(`${this.baseUrl}/api/agent/health`);
  }
}

module.exports = { GorzAgent, requestJson };
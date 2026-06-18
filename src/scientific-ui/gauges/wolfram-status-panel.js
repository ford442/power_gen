export class WolframStatusPanel {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.status = 'disconnected'; // connected, fallback, disconnected
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.lastQueryTime = null;
    this.dataSource = 'fallback'; // wolfram, cached, fallback
    this.queryLog = [];
    this.maxLogEntries = 5;
    
    this.render();
    this.statusEl = this.container.querySelector('.sci-status-dot');
    this.statusTextEl = this.container.querySelector('.sci-status-text');
    this.statusDetailEl = this.container.querySelector('.sci-status-detail');
    this.sourceEl = this.container.querySelector('.sci-data-source');
    this.cacheHitsEl = this.container.querySelector('.sci-cache-hits');
    this.cacheMissesEl = this.container.querySelector('.sci-cache-misses');
    this.lastUpdateEl = this.container.querySelector('.sci-last-update');
    this.logEl = this.container.querySelector('.sci-query-log');
  }
  
  render() {
    this.container.innerHTML = `
      <div class="sci-gauge-section">
        <div class="sci-wolfram-status">
          <div class="sci-status-indicator">
            <div class="sci-status-dot disconnected"></div>
            <div>
              <div class="sci-status-text">Wolfram MCP Disconnected</div>
              <div class="sci-status-detail">Using estimated values ⚠️</div>
            </div>
          </div>
          <span class="sci-data-source">Fallback</span>
        </div>
      </div>
      
      <div class="sci-cache-status">
        <div class="sci-cache-stats">
          <span class="sci-cache-hits">0</span> hits | <span class="sci-cache-misses">0</span> misses
        </div>
        <div class="sci-last-update">--</div>
      </div>
      
      <div class="sci-query-log"></div>
    `;
  }
  
  /**
   * Update connection status
   */
  setStatus(status, message = null) {
    this.status = status;
    
    this.statusEl.className = 'sci-status-dot ' + status;
    
    const statusMap = {
      connected: { text: 'Wolfram MCP Connected', detail: 'Real-time queries active' },
      fallback: { text: 'Wolfram MCP Limited', detail: 'Using cached values' },
      disconnected: { text: 'Wolfram MCP Disconnected', detail: 'Using estimated values ⚠️' }
    };
    
    const info = statusMap[status];
    this.statusTextEl.textContent = message || info.text;
    this.statusDetailEl.textContent = info.detail;
  }
  
  /**
   * Set current data source
   */
  setDataSource(source) {
    this.dataSource = source;
    const sourceLabels = {
      wolfram: 'Wolfram',
      cached: 'Cached',
      fallback: 'Fallback'
    };
    this.sourceEl.textContent = sourceLabels[source] || 'Unknown';
  }
  
  /**
   * Update cache statistics
   */
  updateCacheStats(hits, misses) {
    this.cacheHits = hits;
    this.cacheMisses = misses;
    this.cacheHitsEl.textContent = hits;
    this.cacheMissesEl.textContent = misses;
  }
  
  /**
   * Record a cache hit
   */
  recordHit() {
    this.cacheHits++;
    this.cacheHitsEl.textContent = this.cacheHits;
    this.lastQueryTime = Date.now();
    this.updateLastUpdate();
  }
  
  /**
   * Record a cache miss
   */
  recordMiss() {
    this.cacheMisses++;
    this.cacheMissesEl.textContent = this.cacheMisses;
    this.lastQueryTime = Date.now();
    this.updateLastUpdate();
  }
  
  /**
   * Add entry to query log
   */
  addLogEntry(query, status) {
    const entry = {
      time: new Date(),
      query: query,
      status: status // hit, miss, error
    };
    
    this.queryLog.unshift(entry);
    if (this.queryLog.length > this.maxLogEntries) {
      this.queryLog.pop();
    }
    
    this.renderLog();
  }
  
  renderLog() {
    this.logEl.innerHTML = this.queryLog.map(entry => {
      const timeStr = entry.time.toLocaleTimeString('en-US', { 
        hour12: false, 
        hour: '2-digit', 
        minute: '2-digit',
        second: '2-digit'
      });
      const shortQuery = entry.query.length > 25 
        ? entry.query.substring(0, 22) + '...' 
        : entry.query;
      
      return `
        <div class="sci-query-entry">
          <span class="sci-query-time">${timeStr}</span>
          <span class="sci-query-status ${entry.status}"></span>
          <span class="sci-query-text" title="${entry.query}">${shortQuery}</span>
        </div>
      `;
    }).join('');
  }
  
  updateLastUpdate() {
    if (!this.lastQueryTime) {
      this.lastUpdateEl.textContent = '--';
      return;
    }
    
    const seconds = ((Date.now() - this.lastQueryTime) / 1000).toFixed(2);
    this.lastUpdateEl.textContent = seconds + 's ago';
  }
  
  /**
   * Start periodic update of "last update" text
   */
  startUpdateLoop() {
    setInterval(() => this.updateLastUpdate(), 100);
  }
}

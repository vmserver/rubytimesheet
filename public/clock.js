(function() {
  function init() {
    var tMain = document.getElementById('ny-time-main');
    var tAmPm = document.getElementById('ny-time-ampm');
    var dText = document.getElementById('ny-date-full');
    if (!tMain && !tAmPm && !dText) return;
    function tick() {
      var now = new Date();
      var parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour12: true,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      }).formatToParts(now);
      var hh = (parts.find(function(p){ return p.type === 'hour'; }) || {}).value || '';
      var mm = (parts.find(function(p){ return p.type === 'minute'; }) || {}).value || '';
      var ss = (parts.find(function(p){ return p.type === 'second'; }) || {}).value || '';
      var dp = (parts.find(function(p){ return p.type === 'dayPeriod'; }) || {}).value || '';
      if (tMain) tMain.textContent = hh + ':' + mm + ':' + ss;
      if (tAmPm) tAmPm.textContent = dp ? dp.toUpperCase() : '';
      var dparts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        month: 'short',
        day: '2-digit',
        year: 'numeric'
      }).formatToParts(now);
      var mon = (dparts.find(function(p){ return p.type === 'month'; }) || {}).value || '';
      var day = (dparts.find(function(p){ return p.type === 'day'; }) || {}).value || '';
      var yr = (dparts.find(function(p){ return p.type === 'year'; }) || {}).value || '';
      if (dText) dText.textContent = mon + ' ' + day + ' ' + yr;
    }
    tick();
    setInterval(tick, 1000);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

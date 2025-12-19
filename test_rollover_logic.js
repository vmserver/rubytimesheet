const TIMEZONE = 'America/New_York';

function testLogic(nowStr) {
  const now = new Date(nowStr);
  console.log('--- Testing with now:', now.toISOString(), '---');
  
  const nyFormatter = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = nyFormatter.formatToParts(now);
  const y = parseInt(parts.find(p => p.type === 'year').value);
  const m = parseInt(parts.find(p => p.type === 'month').value);
  const d = parseInt(parts.find(p => p.type === 'day').value);
  
  const offsetMin = (() => {
    const probe = new Date(Date.UTC(y, m - 1, d, 12));
    const s = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, timeZoneName: 'shortOffset', hour: '2-digit', minute: '2-digit' }).format(probe);
    const mm = s.match(/GMT([+-]\d+)/);
    const hours = mm ? parseInt(mm[1], 10) : -5;
    return hours * 60;
  })();
  
  const endYesterdayUTC = new Date(Date.UTC(y, m - 1, d - 1, 23, 59, 59) + (-offsetMin) * 60 * 1000);

  console.log('endYesterdayUTC:', endYesterdayUTC.toISOString());

  // Logic for break_end
  const be = new Date(endYesterdayUTC);
  be.setSeconds(be.getSeconds() - 1);
  console.log('break_end calculated:', be.toISOString());
  
  console.log('out calculated:', endYesterdayUTC.toISOString());
  
  if (be.getTime() === endYesterdayUTC.getTime()) {
      console.error('ERROR: break_end and out have SAME timestamp!');
  } else if (be.getTime() > endYesterdayUTC.getTime()) {
      console.error('ERROR: break_end is AFTER out!');
  } else {
      console.log('SUCCESS: break_end is correctly before out');
  }
}

// Test case 1: Standard midnight
// 2025-12-18 00:00:05 NY time -> 2025-12-18 05:00:05 UTC
testLogic('2025-12-18T05:00:05Z');

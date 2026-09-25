// Temporary controlled end-to-end validation for the current Render deployment.
// It reuses AutoTube's existing /api/preflight job so the real pipeline is tested
// inside the Render instance, without changing the AI structure generation.
// Remove this preload after the validation pass is complete.

if (String(process.env.RENDER || '').toLowerCase() === 'true') {
  const originalFetch = global.fetch;
  const referenceUrl = 'https://www.youtube.com/watch?v=AaZy5CmL5co';
  let started = false;

  global.fetch = async function preflightReferenceFetch(url, options = {}) {
    const value = String(url || '');
    if (/http:\/\/127\.0\.0\.1:\d+\/api\/youtube\/reference$/i.test(value) && String(options?.method || '').toUpperCase() === 'POST') {
      try {
        const body = JSON.parse(String(options.body || '{}'));
        if (body && body.reference) {
          const next = { ...body, reference: referenceUrl };
          return originalFetch(url, { ...options, body: JSON.stringify(next) });
        }
      } catch (_) {}
    }
    return originalFetch(url, options);
  };

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  (async () => {
    await sleep(10000);
    if (started) return;
    started = true;
    const base = `http://127.0.0.1:${process.env.PORT || 10000}`;
    console.log('AUTOTUBE_E2E_TEST_START reference=' + referenceUrl);
    try {
      const start = await originalFetch(base + '/api/preflight');
      const startData = await start.json();
      console.log('AUTOTUBE_E2E_TEST_JOB ' + JSON.stringify(startData));
      const jobId = startData?.jobId;
      if (!jobId) throw new Error('Preflight no devolvió jobId.');

      for (let i = 0; i < 240; i++) {
        await sleep(5000);
        const response = await originalFetch(base + '/api/preflight/' + encodeURIComponent(jobId));
        const data = await response.json();
        if (data?.status === 'running') {
          console.log('AUTOTUBE_E2E_TEST_PROGRESS elapsedMs=' + String(data.elapsedMs || 0));
          continue;
        }
        console.log('AUTOTUBE_E2E_TEST_RESULT ' + JSON.stringify(data));
        if (data?.status === 'done' && data?.ok) console.log('AUTOTUBE_E2E_TEST_PASS');
        else console.error('AUTOTUBE_E2E_TEST_FAIL');
        return;
      }
      console.error('AUTOTUBE_E2E_TEST_FAIL timeout');
    } catch (err) {
      console.error('AUTOTUBE_E2E_TEST_FAIL ' + (err?.stack || err?.message || String(err)));
    }
  })();
}

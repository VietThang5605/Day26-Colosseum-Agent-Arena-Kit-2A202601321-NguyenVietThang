// docs/js/simulator.js — Pyodide WebAssembly Duel Simulator

let pyodideInstance = null;
let isInitializing = false;
let initPromise = null;

export async function initPyodideSimulator(onProgress) {
  if (pyodideInstance) return pyodideInstance;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      if (onProgress) onProgress({ status: 'loading_engine', message: 'Tải engine Python WebAssembly (Pyodide)...' });

      // Dynamically load Pyodide CDN script if not present
      if (!window.loadPyodide) {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = 'https://cdn.jsdelivr.net/pyodide/v0.26.2/full/pyodide.js';
          script.onload = resolve;
          script.onerror = () => reject(new Error('Không thể tải Pyodide CDN. Vui lòng kiểm tra kết nối mạng.'));
          document.head.appendChild(script);
        });
      }

      if (onProgress) onProgress({ status: 'initializing', message: 'Khởi tạo môi trường Python 3.12 trong trình duyệt...' });
      pyodideInstance = await window.loadPyodide({
        indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.26.2/full/',
      });

      if (onProgress) onProgress({ status: 'loading_sim', message: 'Nạp bộ quy tắc Colosseum Arena...' });
      const simPyRes = await fetch('./python/arena_sim.py', { cache: 'no-store' });
      if (!simPyRes.ok) throw new Error(`Không thể tải arena_sim.py (HTTP ${simPyRes.status})`);
      const simPyCode = await simPyRes.text();

      await pyodideInstance.runPythonAsync(simPyCode);

      if (onProgress) onProgress({ status: 'ready', message: 'Đấu trường sẵn sàng! ⚔️' });
      return pyodideInstance;
    } catch (err) {
      if (onProgress) onProgress({ status: 'error', message: `Lỗi khởi tạo: ${err.message}` });
      throw err;
    }
  })();

  return initPromise;
}

export async function runSimulation(bundleABase64, bundleBBase64, seed = 1, rounds = 10) {
  const pyodide = await initPyodideSimulator();
  
  // Call simulate_from_js Python function
  const runSim = pyodide.globals.get('simulate_from_js');
  const rawResultJson = runSim(bundleABase64, bundleBBase64, Number(seed), Number(rounds));
  const parsed = JSON.parse(rawResultJson);
  
  // Parse trace lines into array of objects
  const events = parsed.jsonl
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));

  return {
    ...parsed,
    events,
  };
}

(() => {
  const $ = s => document.querySelector(s);
  const viewer = $('#viewer'), chList = $('#chList'), seek = $('#seek'), info = $('#info');
  const IMG = /\.(jpe?g|png|gif|webp|avif|bmp)$/i;
  const natural = (a, b) => a.localeCompare(b, undefined, {numeric: true, sensitivity: 'base'});

  let S = {mode: 'scroll', dir: 'rtl', fit: 'w', zoom: 100, theme: 'dark'};
  try { Object.assign(S, JSON.parse(localStorage.getItem('mangaReader') || '{}')); } catch (e) {}
  const save = () => { try { localStorage.setItem('mangaReader', JSON.stringify(S)); } catch (e) {} };

  const chapters = [];   // {id, name, order, blobs, pages:[url]}
  let cur = -1;          // chapter index
  let page = 0;          // halaman (0-based) – awal dari tampilan saat ini
  let io = null;
  let lastY = 0, ignoreUntil = 0;   // untuk menu otomatis saat scroll
  let seq = 0;

  /* ---------- util ---------- */
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 1600);
  }
  const cur_ = () => chapters[cur];

  /* ---------- penyimpanan permanen (IndexedDB) ---------- */
  const DB_NAME = 'manga-reader', STORE = 'chapters';
  let dbp = null;
  function openDb() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, {keyPath: 'id'});
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { dbp = null; reject(req.error); };
    });
    return dbp;
  }
  function dbTx(mode, fn) {
    return openDb().then(d => new Promise((resolve, reject) => {
      const t = d.transaction(STORE, mode), r = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(r && r.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }
  function saveChapter(ch) {
    return dbTx('readwrite', s => s.put({id: ch.id, name: ch.name, order: ch.order, pages: ch.blobs}));
  }
  function deleteChapter(id) {
    return dbTx('readwrite', s => s.delete(id));
  }
  function loadChapters() {
    return dbTx('readonly', s => s.getAll()).then(rows => (rows || [])
      .sort((a, b) => a.order - b.order)
      .map(r => ({
        id: r.id, name: r.name, order: r.order, blobs: r.pages,
        pages: r.pages.map(b => URL.createObjectURL(b))
      })));
  }
  function newChapter(name, blobs) {
    seq++;
    const id = Date.now().toString(36) + seq + Math.random().toString(36).slice(2, 6);
    return {id, name, order: Date.now() + seq, blobs, pages: blobs.map(b => URL.createObjectURL(b))};
  }
  if (navigator.storage && navigator.storage.persist) {
    try { navigator.storage.persist().catch(() => {}); } catch (e) {}
  }

  /* ---------- memuat file ---------- */
  async function addFiles(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    const zips = files.filter(f => /\.(zip|cbz)$/i.test(f.name));
    const imgs = files.filter(f => f.type.startsWith('image/') || IMG.test(f.name));
    const before = chapters.length;
    const added = [];

    for (const z of zips.sort((a, b) => natural(a.name, b.name))) {
      try {
        const zip = await JSZip.loadAsync(z);
        const entries = Object.values(zip.files).filter(e => !e.dir && IMG.test(e.name) && !e.name.includes('__MACOSX'));
        const groups = {};
        entries.forEach(e => {
          const i = e.name.lastIndexOf('/');
          (groups[i < 0 ? '' : e.name.slice(0, i)] ||= []).push(e);
        });
        for (const key of Object.keys(groups).sort(natural)) {
          const list = groups[key].sort((a, b) => natural(a.name, b.name));
          const blobs = [];
          for (const e of list) {
            const b = await e.async('blob');
            blobs.push(new Blob([b], {type: mime(e.name)}));
          }
          const base = z.name.replace(/\.(zip|cbz)$/i, '');
          added.push(newChapter(key ? `${base} / ${key.split('/').pop()}` : base, blobs));
        }
      } catch (err) { toast('Gagal membaca ' + z.name); console.error(err); }
    }

    if (imgs.length) {
      const groups = {};
      imgs.forEach(f => {
        const p = f.webkitRelativePath || '';
        const dir = p ? p.split('/').slice(0, -1).join('/') : '';
        (groups[dir] ||= []).push(f);
      });
      const keys = Object.keys(groups).sort(natural);
      keys.forEach(k => {
        const list = groups[k].sort((a, b) => natural(a.name, b.name));
        const name = k ? k.split('/').pop() : `Chapter ${before + added.length + 1}`;
        added.push(newChapter(name, list));
      });
    }

    if (!added.length) { toast('Tidak ada gambar yang ditemukan'); return; }

    // simpan ke IndexedDB dulu; hanya chapter yang berhasil disimpan yang ditampilkan
    let failed = 0;
    for (const ch of added) {
      try {
        await saveChapter(ch);
        chapters.push(ch);
      } catch (err) {
        failed++; console.error(err);
        ch.pages.forEach(u => URL.revokeObjectURL(u));
      }
    }

    const okCount = chapters.length - before;
    if (!okCount) { toast('Gagal menyimpan chapter ke browser (penyimpanan penuh atau mode privat)'); return; }
    renderList();
    if (cur < 0 || before === 0) openChapter(before, 0);
    else toast(`${okCount} chapter ditambahkan`);
    if (failed) setTimeout(() => toast(`${failed} chapter gagal disimpan`), 1700);
  }
  function mime(n) {
    const e = n.split('.').pop().toLowerCase();
    return {jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp'}[e] || 'image/*';
  }

  /* ---------- daftar chapter ---------- */
  function renderList() {
    chList.innerHTML = '';
    if (!chapters.length) {
      chList.innerHTML = '<div style="padding:10px 14px;color:var(--muted)">Belum ada chapter.</div>';
      return;
    }
    chapters.forEach((c, i) => {
      const el = document.createElement('div');
      el.className = 'ch' + (i === cur ? ' active' : '');
      el.innerHTML = '<span class="n"></span><small>' + c.pages.length + ' hlm</small><button class="x" title="Hapus">✕</button>';
      el.querySelector('.n').textContent = c.name;
      el.onclick = e => { if (e.target.classList.contains('x')) return removeChapter(i); openChapter(i, 0); };
      chList.appendChild(el);
    });
  }
  function removeChapter(i) {
    const ch = chapters[i];
    ch.pages.forEach(u => URL.revokeObjectURL(u));
    deleteChapter(ch.id).catch(err => console.error(err));
    chapters.splice(i, 1);
    if (!chapters.length) { cur = -1; page = 0; renderList(); render(); return; }
    if (i < cur) cur--;
    else if (i === cur) { cur = Math.min(cur, chapters.length - 1); page = 0; }
    renderList(); render();
  }

  /* ---------- tampilan ---------- */
  function spreads() {
    const n = cur_().pages.length, out = [];
    if (S.mode !== 'double') { for (let i = 0; i < n; i++) out.push([i]); return out; }
    out.push([0]);                         // sampul sendirian
    for (let i = 1; i < n; i += 2) out.push(i + 1 < n ? [i, i + 1] : [i]);
    return out;
  }
  const spreadIdx = (sp, p) => Math.max(0, sp.findIndex(s => s.includes(p)));

  const touchUI = matchMedia('(max-width:700px),(pointer:coarse)');
  function setImmersive(on) {
    document.body.classList.toggle('immersive', !!on && touchUI.matches && cur >= 0);
  }
  const topPad = () => parseFloat(getComputedStyle(document.querySelector('main')).paddingTop) || 0;
  function jumpTo(y) { ignoreUntil = Date.now() + 500; window.scrollTo(0, Math.max(0, y)); lastY = window.scrollY; }
  function jumpToEl(el) { if (el) jumpTo(el.getBoundingClientRect().top + window.scrollY - topPad()); }

  function openChapter(i, p) {
    cur = i; page = p || 0;
    renderList(); render();
    if (chapters[i]) toast(chapters[i].name);
    if (touchUI.matches) {
      // di HP: langsung layar penuh + sembunyikan menu
      setImmersive(true);
      if (!openChapter.hinted) { openChapter.hinted = true; setTimeout(() => toast('Ketuk layar untuk menampilkan menu'), 1800); }
      $('#side').classList.add('hidden');
    }
  }

  function render() {
    if (io) { io.disconnect(); io = null; }
    viewer.innerHTML = ''; viewer.className = ''; jumpTo(0);
    document.documentElement.style.setProperty('--zoom', S.zoom);
    $('#zVal').textContent = S.zoom + '%';

    if (cur < 0 || !chapters.length) {
      setImmersive(false);
      viewer.classList.add('center');
      viewer.innerHTML = `<div class="empty"><h2>Mulai baca</h2>
        <p>Upload gambar halaman manga (JPG/PNG/WebP), file <b>.zip / .cbz</b>, atau seluruh folder.<br>Bisa juga <b>drag &amp; drop</b> ke sini.</p>
        <label class="btn primary">Pilih file<input type="file" accept="image/*,.zip,.cbz" multiple hidden id="emptyPick"></label></div>`;
      $('#emptyPick').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
      seek.max = 1; seek.value = 1; info.textContent = '–';
      return;
    }

    const c = cur_(), n = c.pages.length;
    seek.max = n;

    if (S.mode === 'scroll') {
      const wrap = document.createElement('div'); wrap.className = 'scroll';
      c.pages.forEach((u, i) => {
        const im = new Image(); im.src = u; im.loading = 'lazy'; im.dataset.i = i; im.alt = 'Halaman ' + (i + 1);
        im.style.minHeight = '200px';
        im.onload = () => im.style.minHeight = '';
        wrap.appendChild(im);
      });
      viewer.appendChild(wrap);
      io = new IntersectionObserver(es => {
        es.forEach(e => { if (e.isIntersecting) { page = +e.target.dataset.i; updateInfo(); } });
      }, {rootMargin: '-45% 0px -45% 0px'});
      wrap.querySelectorAll('img').forEach(im => io.observe(im));
      requestAnimationFrame(() => jumpToEl(wrap.children[page]));
    } else {
      const sp = spreads(), si = spreadIdx(sp, page), cur_sp = sp[si];
      page = cur_sp[0];
      viewer.classList.add('paged', 'fit-' + S.fit);
      if (S.fit === 'o') viewer.classList.add('orig');
      const box = document.createElement('div');
      box.className = 'spread' + (cur_sp.length > 1 ? ' two' : '') + (S.dir === 'rtl' ? ' rtl' : '');
      cur_sp.forEach(i => { const im = new Image(); im.src = c.pages[i]; im.draggable = false; box.appendChild(im); });
      viewer.appendChild(box);
      // area klik kiri/kanan
      ['l', 'r'].forEach(side => {
        const h = document.createElement('div'); h.className = 'hit ' + side;
        const forward = (S.dir === 'rtl') ? side === 'l' : side === 'r';
        h.onclick = () => forward ? go(1) : go(-1);
        viewer.parentElement.appendChild(h);
      });
      // preload
      const nx = sp[si + 1]; if (nx) nx.forEach(i => { new Image().src = c.pages[i]; });
    }
    cleanHits();
    updateInfo();
  }
  function cleanHits() {
    // hapus area klik lama jika mode scroll
    const mainEl = viewer.parentElement;
    const hits = [...mainEl.querySelectorAll('.hit')];
    if (S.mode === 'scroll' || cur < 0) { hits.forEach(h => h.remove()); return; }
    // simpan hanya 2 yang terakhir dibuat
    hits.slice(0, Math.max(0, hits.length - 2)).forEach(h => h.remove());
  }

  function updateInfo() {
    if (cur < 0) return;
    const n = cur_().pages.length;
    seek.value = page + 1;
    let txt = `${page + 1} / ${n}`;
    if (S.mode === 'double') { const s = spreads()[spreadIdx(spreads(), page)]; if (s.length > 1) txt = `${s[0] + 1}-${s[1] + 1} / ${n}`; }
    info.textContent = txt + (chapters.length > 1 ? `  ·  Ch ${cur + 1}/${chapters.length}` : '');
    $('#prevCh').disabled = cur <= 0;
    $('#nextCh').disabled = cur >= chapters.length - 1;
  }

  /* ---------- navigasi ---------- */
  function go(dir) {
    if (cur < 0) return;
    if (S.mode === 'scroll') {
      window.scrollBy({top: dir * window.innerHeight * 0.85, behavior: 'smooth'});
      const atEnd = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4;
      if (dir > 0 && atEnd) nextChapter();
      return;
    }
    const sp = spreads(), si = spreadIdx(sp, page), ni = si + dir;
    if (ni >= sp.length) return nextChapter();
    if (ni < 0) return prevChapter(true);
    page = sp[ni][0]; render();
  }
  function nextChapter() {
    if (cur < chapters.length - 1) openChapter(cur + 1, 0);
    else toast('Chapter terakhir');
  }
  function prevChapter(toEnd) {
    if (cur > 0) openChapter(cur - 1, toEnd ? chapters[cur - 1].pages.length - 1 : 0);
    else toast('Chapter pertama');
  }
  function jump(p) {
    page = Math.max(0, Math.min(cur_().pages.length - 1, p));
    if (S.mode === 'scroll') {
      jumpToEl(viewer.querySelector('.scroll').children[page]);
    } else render();
    updateInfo();
  }

  /* ---------- kontrol ---------- */
  $('#fileImg').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
  $('#fileDir').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
  $('#prev').onclick = () => go(-1);
  $('#next').onclick = () => go(1);
  $('#prevCh').onclick = () => prevChapter();
  $('#nextCh').onclick = () => nextChapter();
  seek.oninput = () => jump(+seek.value - 1);
  $('#btnSide').onclick = () => $('#side').classList.toggle('hidden');

  const selMode = $('#selMode'), selDir = $('#selDir'), selFit = $('#selFit');
  selMode.onchange = () => { S.mode = selMode.value; save(); applyUI(); render(); };
  selDir.onchange = () => { S.dir = selDir.value; save(); render(); };
  selFit.onchange = () => { S.fit = selFit.value; save(); render(); };
  const zoom = d => { S.zoom = Math.max(50, Math.min(200, S.zoom + d)); save(); document.documentElement.style.setProperty('--zoom', S.zoom); $('#zVal').textContent = S.zoom + '%'; };
  $('#zIn').onclick = () => zoom(10);
  $('#zOut').onclick = () => zoom(-10);
  $('#btnTheme').onclick = toggleTheme;
  $('#btnFs').onclick = toggleFs;

  function toggleTheme() { S.theme = S.theme === 'dark' ? 'light' : 'dark'; save(); applyUI(); }
  function toggleFs() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  }
  document.addEventListener('fullscreenchange', () => document.body.classList.toggle('fs', !!document.fullscreenElement));

  function applyUI() {
    document.documentElement.classList.toggle('light', S.theme === 'light');
    selMode.value = S.mode; selDir.value = S.dir; selFit.value = S.fit;
    selDir.style.display = S.mode === 'scroll' ? 'none' : '';
    selFit.style.display = S.mode === 'scroll' ? 'none' : '';
  }

  /* keyboard */
  addEventListener('keydown', e => {
    if (e.target.matches('input[type=range],select') && ['ArrowLeft', 'ArrowRight'].includes(e.key)) e.target.blur();
    const rtl = S.dir === 'rtl' && S.mode !== 'scroll';
    switch (e.key) {
      case 'ArrowRight': e.preventDefault(); go(rtl ? -1 : 1); break;
      case 'ArrowLeft': e.preventDefault(); go(rtl ? 1 : -1); break;
      case 'ArrowDown': if (S.mode !== 'scroll') { e.preventDefault(); go(1); } break;
      case 'ArrowUp': if (S.mode !== 'scroll') { e.preventDefault(); go(-1); } break;
      case ' ': e.preventDefault(); go(e.shiftKey ? -1 : 1); break;
      case 'PageDown': if (S.mode !== 'scroll') go(1); break;
      case 'PageUp': if (S.mode !== 'scroll') go(-1); break;
      case 'Home': jump(0); break;
      case 'End': jump(cur_() ? cur_().pages.length - 1 : 0); break;
      case 'f': case 'F': toggleFs(); break;
      case 't': case 'T': toggleTheme(); break;
      case 'l': case 'L': $('#side').classList.toggle('hidden'); break;
      case 'd': case 'D': S.dir = S.dir === 'rtl' ? 'ltr' : 'rtl'; save(); applyUI(); render(); toast(S.dir === 'rtl' ? 'Kanan → Kiri' : 'Kiri → Kanan'); break;
      case 'm': case 'M': S.mode = {scroll: 'single', single: 'double', double: 'scroll'}[S.mode]; save(); applyUI(); render(); break;
      case '+': case '=': zoom(10); break;
      case '-': zoom(-10); break;
      case '[': prevChapter(); break;
      case ']': nextChapter(); break;
    }
  });

  /* drag & drop */
  ['dragenter', 'dragover'].forEach(ev => addEventListener(ev, e => { e.preventDefault(); document.body.classList.add('drop'); }));
  ['dragleave', 'drop'].forEach(ev => addEventListener(ev, e => { e.preventDefault(); if (ev === 'drop' || e.relatedTarget === null) document.body.classList.remove('drop'); }));
  addEventListener('drop', async e => {
    const items = e.dataTransfer.items;
    if (items && items[0]?.webkitGetAsEntry) {
      const files = [];
      const walk = async (entry, path) => {
        if (entry.isFile) {
          await new Promise(r => entry.file(f => { Object.defineProperty(f, 'webkitRelativePath', {value: path + f.name}); files.push(f); r(); }));
        } else if (entry.isDirectory) {
          const rd = entry.createReader(); let batch;
          do { batch = await new Promise(r => rd.readEntries(r)); for (const x of batch) await walk(x, path + entry.name + '/'); } while (batch.length);
        }
      };
      for (const it of items) { const en = it.webkitGetAsEntry(); if (en) await walk(en, ''); }
      addFiles(files);
    } else addFiles(e.dataTransfer.files);
  });

  /* ketuk layar = tampil/sembunyikan menu (HP) */
  viewer.addEventListener('click', e => {
    if (!touchUI.matches || cur < 0) return;
    if (e.target.closest('.empty,label,button')) return;
    setImmersive(!document.body.classList.contains('immersive'));
  });
  // scroll ke bawah = menu hilang, scroll ke atas = menu muncul (HP)
  addEventListener('scroll', () => {
    if (!touchUI.matches || S.mode !== 'scroll' || cur < 0) return;
    if (Date.now() < ignoreUntil) { lastY = window.scrollY; return; }
    const y = window.scrollY, d = y - lastY;
    if (Math.abs(d) > 40) { setImmersive(d > 0); lastY = y; }
  }, {passive: true});
  $('#toTop').onclick = () => window.scrollTo({top: 0, behavior: 'smooth'});

  /* init: muat chapter yang tersimpan di browser */
  applyUI(); renderList(); render();
  loadChapters().then(list => {
    if (!list.length) return;
    chapters.push(...list);
    renderList();
    openChapter(0, 0);
    toast(`${list.length} chapter dimuat dari penyimpanan browser`);
  }).catch(err => {
    console.error(err);
    toast('Penyimpanan browser tidak tersedia (mode privat?)');
  });
})();

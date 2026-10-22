/* ============================================================
   SignBridge — Three.js atmosphere layer (vanilla)
   ------------------------------------------------------------
   Full-bleed particle + soft-wave background, plus a few small
   scoped canvases (logo, stage empty, transcript empty).

   Performance rules (learned from effects.js freeze):
     • no MutationObservers / DOM write loops
     • pointer-events: none on every canvas
     • DPR capped; particle count scales with viewport
     • pause on prefers-reduced-motion, reduceMotion, hidden tab
     • one shared rAF loop for all scenes
   ============================================================ */

window.SB = window.SB || {};

(function () {
  var THREE = window.THREE;
  if (!THREE) {
    console.warn("SB.ThreeFX: THREE not loaded — skipping WebGL layer");
    return;
  }

  var running = false;
  var paused = false;
  var raf = 0;
  var scenes = [];
  var clock = null;
  var reduce = false;
  var pointer = { x: 0, y: 0, tx: 0, ty: 0, bound: false };

  function shouldReduce() {
    if (SB.settings && SB.settings.reduceMotion) return true;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return true;
    }
    return false;
  }

  function capDpr() {
    return Math.min(window.devicePixelRatio || 1, 1.5);
  }

  function makeRenderer(canvas, alpha) {
    var renderer = new THREE.WebGLRenderer({
      canvas: canvas,
      alpha: !!alpha,
      antialias: false,
      powerPreference: "low-power",
      preserveDrawingBuffer: false,
    });
    renderer.setPixelRatio(capDpr());
    renderer.setClearColor(0x000000, alpha ? 0 : 1);
    return renderer;
  }

  function sizeRenderer(entry, w, h) {
    if (w < 2 || h < 2) return;
    entry.renderer.setPixelRatio(capDpr());
    /* updateStyle true so canvas element CSS fills the fixed full-viewport wrap */
    entry.renderer.setSize(w, h, true);
    if (entry.kind === "bg" && entry.el) {
      entry.el.style.width = w + "px";
      entry.el.style.height = h + "px";
    }
    if (entry.camera.isPerspectiveCamera) {
      entry.camera.aspect = w / h;
      entry.camera.updateProjectionMatrix();
    } else if (entry.camera.isOrthographicCamera) {
      var aspect = w / h;
      var view = entry.viewSize || 2;
      entry.camera.left = -view * aspect;
      entry.camera.right = view * aspect;
      entry.camera.top = view;
      entry.camera.bottom = -view;
      entry.camera.updateProjectionMatrix();
    }
    if (entry.onResize) entry.onResize(w, h);
  }

  function bindPointer() {
    if (pointer.bound) return;
    pointer.bound = true;
    window.addEventListener("pointermove", function (e) {
      var w = window.innerWidth || 1;
      var h = window.innerHeight || 1;
      pointer.tx = (e.clientX / w) * 2 - 1;
      pointer.ty = -((e.clientY / h) * 2 - 1);
    }, { passive: true });
  }

  function viewportSize() {
    return {
      w: Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1),
      h: Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1),
    };
  }

  function bindResize(entry, el) {
    if (!window.ResizeObserver) {
      window.addEventListener("resize", function () {
        sizeRenderer(entry, el.clientWidth || window.innerWidth, el.clientHeight || window.innerHeight);
      });
      return;
    }
    var ro = new ResizeObserver(function (entries) {
      var cr = entries[0] && entries[0].contentRect;
      if (!cr) return;
      if (entry.kind === "bg") {
        var vp = viewportSize();
        sizeRenderer(entry, vp.w, vp.h);
      } else {
        sizeRenderer(entry, cr.width, cr.height);
      }
    });
    ro.observe(el);
    window.addEventListener("resize", function () {
      if (entry.kind !== "bg") return;
      var vp = viewportSize();
      sizeRenderer(entry, vp.w, vp.h);
    });
    entry._ro = ro;
  }

  function startLoop() {
    if (running) return;
    running = true;
    clock = new THREE.Clock();
    function tick() {
      raf = requestAnimationFrame(tick);
      if (paused || reduce || document.hidden) return;
      var t = clock.getElapsedTime();
      for (var i = 0; i < scenes.length; i++) {
        var s = scenes[i];
        if (s.update) s.update(t);
        s.renderer.render(s.scene, s.camera);
      }
    }
    raf = requestAnimationFrame(tick);
  }

  function stopLoop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function brandColors() {
    var light = document.documentElement.getAttribute("data-theme") === "light";
    return light
      ? { teal: 0x0d9488, violet: 0x7c3aed, deep: 0xf2f5fd }
      : { teal: 0x2dd4bf, violet: 0xa78bfa, deep: 0x060a14 };
  }

  /* ---------- Full-bleed background ---------- */
  function mountBackground() {
    if (document.querySelector(".sb-three-bg")) return null;

    var wrap = document.createElement("div");
    wrap.className = "sb-three-bg";
    wrap.setAttribute("aria-hidden", "true");
    var canvas = document.createElement("canvas");
    wrap.appendChild(canvas);
    document.body.prepend(wrap);

    var colors = brandColors();
    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.z = 6;

    var renderer = makeRenderer(canvas, true);
    renderer.setClearColor(colors.deep, 0);

    /* Soft wave plane */
    var waveGeo = new THREE.PlaneGeometry(28, 16, 56, 36);
    var waveMat = new THREE.MeshBasicMaterial({
      color: colors.teal,
      transparent: true,
      opacity: 0.045,
      wireframe: true,
    });
    var wave = new THREE.Mesh(waveGeo, waveMat);
    wave.position.z = -2.5;
    wave.rotation.x = -0.55;
    scene.add(wave);

    var wave2 = wave.clone();
    wave2.material = waveMat.clone();
    wave2.material.color = new THREE.Color(colors.violet);
    wave2.material.opacity = 0.035;
    wave2.position.z = -3.2;
    wave2.rotation.x = -0.4;
    scene.add(wave2);

    /* Particle field — wide, even coverage (no left-heavy cluster) */
    var count = Math.max(320, Math.min(1000, Math.floor((window.innerWidth * window.innerHeight) / 2400)));
    var positions = new Float32Array(count * 3);
    var speeds = new Float32Array(count);
    for (var i = 0; i < count; i++) {
      /* Uniform box in camera view; slightly larger than frustum */
      positions[i * 3] = (Math.random() - 0.5) * 22;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 14;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 8;
      speeds[i] = 0.12 + Math.random() * 0.4;
    }
    var pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    var pMat = new THREE.PointsMaterial({
      size: 0.03,
      color: colors.teal,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      sizeAttenuation: true,
    });
    var points = new THREE.Points(pGeo, pMat);
    scene.add(points);

    /* Second field uses independent random positions so teal/violet don't stack on the left */
    var positions2 = new Float32Array(count * 3);
    for (var k = 0; k < count; k++) {
      positions2[k * 3] = (Math.random() - 0.5) * 22;
      positions2[k * 3 + 1] = (Math.random() - 0.5) * 14;
      positions2[k * 3 + 2] = (Math.random() - 0.5) * 8 - 0.4;
    }
    var pGeo2 = new THREE.BufferGeometry();
    pGeo2.setAttribute("position", new THREE.BufferAttribute(positions2, 3));
    var pMat2 = new THREE.PointsMaterial({
      size: 0.026,
      color: colors.violet,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
      sizeAttenuation: true,
    });
    var points2 = new THREE.Points(pGeo2, pMat2);
    scene.add(points2);

    var baseY = new Float32Array(waveGeo.attributes.position.array);

    var entry = {
      kind: "bg",
      scene: scene,
      camera: camera,
      renderer: renderer,
      el: wrap,
      update: function (t) {
        pointer.x += (pointer.tx - pointer.x) * 0.05;
        pointer.y += (pointer.ty - pointer.y) * 0.05;
        /* Gentle follow — keep frustum centered so L/R density stays even */
        camera.position.x = pointer.x * 0.22;
        camera.position.y = pointer.y * 0.14;
        camera.lookAt(0, 0, 0);

        var pos = waveGeo.attributes.position;
        var arr = pos.array;
        for (var i = 0; i < arr.length; i += 3) {
          var x = baseY[i];
          var y = baseY[i + 1];
          arr[i + 2] =
            Math.sin(x * 0.4 + t * 0.5) * 0.18 +
            Math.cos(y * 0.55 + t * 0.35) * 0.12;
        }
        pos.needsUpdate = true;
        wave.rotation.z = Math.sin(t * 0.08) * 0.03;
        wave2.rotation.z = -Math.sin(t * 0.06) * 0.035;

        function driftPoints(geo) {
          var p = geo.attributes.position.array;
          for (var j = 0; j < count; j++) {
            p[j * 3 + 1] += Math.sin(t * speeds[j] + j) * 0.0015;
            p[j * 3] += Math.cos(t * 0.1 + j * 0.01) * 0.0005;
            if (p[j * 3 + 1] > 7) p[j * 3 + 1] = -7;
            if (p[j * 3 + 1] < -7) p[j * 3 + 1] = 7;
            if (p[j * 3] > 11) p[j * 3] = -11;
            if (p[j * 3] < -11) p[j * 3] = 11;
          }
          geo.attributes.position.needsUpdate = true;
        }
        driftPoints(pGeo);
        driftPoints(pGeo2);
        points.rotation.y = t * 0.015;
        points2.rotation.y = -t * 0.012;
      },
      syncTheme: function () {
        var c = brandColors();
        waveMat.color.setHex(c.teal);
        wave2.material.color.setHex(c.violet);
        pMat.color.setHex(c.teal);
        pMat2.color.setHex(c.violet);
      },
    };

    bindPointer();
    var vp0 = viewportSize();
    sizeRenderer(entry, vp0.w, vp0.h);
    bindResize(entry, wrap);
    scenes.push(entry);

    /* Dim CSS beams/spotlight so Three owns the atmosphere */
    document.documentElement.classList.add("sb-has-three");
    return entry;
  }

  /* ---------- Small orb accent (logo / empty states) ---------- */
  function mountOrb(host, opts) {
    opts = opts || {};
    if (!host || host.dataset.sbThree === "1") return null;
    host.dataset.sbThree = "1";

    var wrap = document.createElement("div");
    wrap.className = "sb-three-orb" + (opts.className ? " " + opts.className : "");
    wrap.setAttribute("aria-hidden", "true");
    var canvas = document.createElement("canvas");
    wrap.appendChild(canvas);

    var style = window.getComputedStyle(host);
    if (style.position === "static") host.style.position = "relative";
    host.insertBefore(wrap, host.firstChild);

    var colors = brandColors();
    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(40, 1, 0.1, 20);
    camera.position.z = 3.2;
    var renderer = makeRenderer(canvas, true);

    var group = new THREE.Group();
    scene.add(group);

    var sphere = new THREE.Mesh(
      new THREE.SphereGeometry(0.7, 24, 18),
      new THREE.MeshBasicMaterial({
        color: colors.teal,
        transparent: true,
        opacity: 0.18,
        wireframe: true,
      })
    );
    group.add(sphere);

    var ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.95, 0.035, 10, 48),
      new THREE.MeshBasicMaterial({
        color: colors.violet,
        transparent: true,
        opacity: 0.55,
      })
    );
    ring.rotation.x = Math.PI / 2.6;
    group.add(ring);

    var ring2 = ring.clone();
    ring2.material = ring.material.clone();
    ring2.material.color = new THREE.Color(colors.teal);
    ring2.material.opacity = 0.35;
    ring2.rotation.x = Math.PI / 1.7;
    ring2.scale.setScalar(0.78);
    group.add(ring2);

    var entry = {
      kind: "orb",
      scene: scene,
      camera: camera,
      renderer: renderer,
      el: wrap,
      update: function (t) {
        var speed = opts.speed || 1;
        group.rotation.y = t * 0.45 * speed;
        group.rotation.x = Math.sin(t * 0.35 * speed) * 0.25;
        ring.rotation.z = t * 0.6 * speed;
        ring2.rotation.z = -t * 0.4 * speed;
        sphere.scale.setScalar(1 + Math.sin(t * 1.2 * speed) * 0.04);
      },
      syncTheme: function () {
        var c = brandColors();
        sphere.material.color.setHex(c.teal);
        ring.material.color.setHex(c.violet);
        ring2.material.color.setHex(c.teal);
      },
    };

    var w = host.clientWidth || opts.size || 72;
    var h = host.clientHeight || opts.size || 72;
    sizeRenderer(entry, w, h);
    bindResize(entry, wrap);
    scenes.push(entry);
    return entry;
  }

  /* ---------- Demo hand: stylized 3D hand + orbiting teal dots ---------- */
  function buildHandGroup(colors) {
    var hand = new THREE.Group();
    var skin = new THREE.MeshBasicMaterial({
      color: 0xffd7a0,
      transparent: true,
      opacity: 1,
    });
    var tipMat = new THREE.MeshBasicMaterial({
      color: colors.teal,
      transparent: true,
      opacity: 0.35,
    });

    /* Palm */
    var palm = new THREE.Mesh(new THREE.BoxGeometry(0.95, 1.05, 0.28), skin);
    palm.position.set(0, 0.05, 0);
    hand.add(palm);

    /* Soft palm outline for depth */
    var palmEdge = new THREE.Mesh(
      new THREE.BoxGeometry(1.02, 1.12, 0.22),
      new THREE.MeshBasicMaterial({
        color: colors.violet,
        transparent: true,
        opacity: 0.14,
        wireframe: true,
      })
    );
    palmEdge.position.copy(palm.position);
    hand.add(palmEdge);

    function digitGeo(radius, length) {
      if (THREE.CapsuleGeometry) {
        return new THREE.CapsuleGeometry(radius, length, 4, 8);
      }
      return new THREE.CylinderGeometry(radius, radius, length + radius * 2, 10);
    }

    /* Thumb */
    var thumb = new THREE.Mesh(digitGeo(0.11, 0.38), skin);
    thumb.position.set(-0.62, -0.05, 0.12);
    thumb.rotation.z = 0.85;
    thumb.rotation.y = 0.35;
    hand.add(thumb);

    /* Four fingers */
    var fingerX = [-0.3, -0.08, 0.14, 0.36];
    var fingerLen = [0.55, 0.68, 0.62, 0.48];
    for (var f = 0; f < 4; f++) {
      var finger = new THREE.Mesh(digitGeo(0.095, fingerLen[f]), skin);
      finger.position.set(fingerX[f], 0.72 + fingerLen[f] * 0.25, 0.02);
      finger.rotation.x = -0.12 - f * 0.03;
      hand.add(finger);

      var tip = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), tipMat);
      tip.position.set(fingerX[f], 0.72 + fingerLen[f] * 0.55, 0.04);
      hand.add(tip);
    }

    hand.rotation.x = 0.25;
    hand.rotation.z = -0.08;
    return hand;
  }

  function mountDemoHand(host) {
    if (!host || host.dataset.sbThreeHand === "1") return null;
    host.dataset.sbThreeHand = "1";
    host.classList.add("has-three-hand");

    /* Remove emoji text nodes so only the WebGL hand shows */
    Array.prototype.slice.call(host.childNodes).forEach(function (n) {
      if (n.nodeType === 3) host.removeChild(n);
    });

    var wrap = document.createElement("div");
    wrap.className = "sb-three-hand";
    wrap.setAttribute("aria-hidden", "true");
    var canvas = document.createElement("canvas");
    wrap.appendChild(canvas);
    host.insertBefore(wrap, host.firstChild);

    var colors = brandColors();
    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(36, 1, 0.1, 30);
    camera.position.set(0, 0.2, 3.6);
    var renderer = makeRenderer(canvas, true);

    var root = new THREE.Group();
    scene.add(root);

    var hand = buildHandGroup(colors);
    hand.scale.setScalar(1.05);
    hand.position.set(0, -0.15, 0);
    root.add(hand);

    /* Soft glow behind hand */
    var glow = new THREE.Mesh(
      new THREE.SphereGeometry(1.05, 20, 16),
      new THREE.MeshBasicMaterial({
        color: colors.teal,
        transparent: true,
        opacity: 0.1,
      })
    );
    glow.position.set(0, 0.1, -0.4);
    root.add(glow);

    /* Particles that orbit the hand (tight cloud, not a detached band) */
    var count = 64;
    var positions = new Float32Array(count * 3);
    var orbits = [];
    for (var i = 0; i < count; i++) {
      var radius = 0.85 + (i % 6) * 0.1;
      var tilt = ((i % 5) - 2) * 0.18;
      var phase = (i / count) * Math.PI * 2;
      var speed = 0.4 + (i % 6) * 0.09;
      orbits.push({ radius: radius, tilt: tilt, phase: phase, speed: speed, y: ((i % 7) - 3) * 0.07 });
      positions[i * 3] = Math.cos(phase) * radius;
      positions[i * 3 + 1] = Math.sin(phase * 0.7) * 0.15;
      positions[i * 3 + 2] = Math.sin(phase) * radius * 0.55;
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    var mat = new THREE.PointsMaterial({
      size: 0.055,
      color: colors.teal,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      sizeAttenuation: true,
    });
    var pts = new THREE.Points(geo, mat);
    root.add(pts);

    var mat2 = mat.clone();
    mat2.color = new THREE.Color(colors.violet);
    mat2.size = 0.04;
    mat2.opacity = 0.55;
    var pts2 = new THREE.Points(geo.clone(), mat2);
    root.add(pts2);

    var entry = {
      kind: "hand",
      scene: scene,
      camera: camera,
      renderer: renderer,
      el: wrap,
      update: function (t) {
        hand.rotation.y = Math.sin(t * 0.55) * 0.35;
        hand.rotation.x = 0.22 + Math.sin(t * 0.4) * 0.08;
        hand.position.y = Math.sin(t * 1.1) * 0.06;
        glow.scale.setScalar(1 + Math.sin(t * 1.3) * 0.06);

        var arr = geo.attributes.position.array;
        for (var i = 0; i < count; i++) {
          var o = orbits[i];
          var a = o.phase + t * o.speed;
          arr[i * 3] = Math.cos(a) * o.radius;
          arr[i * 3 + 1] = o.y + Math.sin(a * 1.4 + o.tilt) * 0.28;
          arr[i * 3 + 2] = Math.sin(a) * o.radius * 0.65 + o.tilt * 0.12;
        }
        geo.attributes.position.needsUpdate = true;
        pts2.geometry.attributes.position.array.set(arr);
        pts2.geometry.attributes.position.needsUpdate = true;
        pts.rotation.y = t * 0.12;
        pts2.rotation.y = -t * 0.08;
      },
      syncTheme: function () {
        var c = brandColors();
        mat.color.setHex(c.teal);
        mat2.color.setHex(c.violet);
        glow.material.color.setHex(c.teal);
      },
    };

    var size = Math.max(host.clientWidth || 120, host.clientHeight || 120);
    sizeRenderer(entry, size, size);
    bindResize(entry, wrap);
    scenes.push(entry);
    return entry;
  }

  function syncAllThemes() {
    for (var i = 0; i < scenes.length; i++) {
      if (scenes[i].syncTheme) scenes[i].syncTheme();
    }
  }

  function applyMotionPolicy() {
    reduce = shouldReduce();
    paused = reduce;
    document.documentElement.classList.toggle("sb-three-paused", paused);
    if (!paused && scenes.length) startLoop();
  }

  SB.mountThreeFX = function () {
    if (SB._threeMounted) return;
    if (!window.THREE) return;
    if (shouldReduce()) {
      document.documentElement.classList.add("sb-three-paused");
      return;
    }

    try {
      SB._threeMounted = true;
      mountBackground();

      /* Logo / demo-hand / empty-icon stay flat (Lucide or emoji) — no Three orbs */

      applyMotionPolicy();
      startLoop();

      /* Theme changes — cheap color sync, no rebuild */
      if (!SB._threeThemeBound) {
        SB._threeThemeBound = true;
        var obs = new MutationObserver(function () {
          requestAnimationFrame(syncAllThemes);
        });
        obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
      }

      document.addEventListener("visibilitychange", function () {
        if (!document.hidden && !shouldReduce()) paused = false;
      });

    } catch (err) {
      console.warn("SB.mountThreeFX failed:", err);
    }
  };

  SB.pauseThreeFX = function () {
    paused = true;
    document.documentElement.classList.add("sb-three-paused");
  };

  SB.resumeThreeFX = function () {
    if (shouldReduce()) return;
    paused = false;
    document.documentElement.classList.remove("sb-three-paused");
    if (scenes.length) startLoop();
  };

  /* Re-apply when settings toggle reduce motion */
  SB.refreshThreeMotion = function () {
    applyMotionPolicy();
  };
})();

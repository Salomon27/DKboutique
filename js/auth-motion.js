export let currentTimeline = null;
export let idleTimeline = null;
export let verifyingTimeline = null;

const els = {};
let mouseX = 0;
let mouseY = 0;
let parallaxEnabled = true;

function initEls() {
    if (Object.keys(els).length > 0) return;
    
    els.manager = document.getElementById('managerLayer');
    els.courier = document.getElementById('courierLayer');
    els.tablet = document.getElementById('tabletLayer');
    els.orderCard = document.getElementById('orderCardLayer');
    els.parcels = document.getElementById('parcelsLayer');
    els.route = document.getElementById('routeLayer');
    els.processing = document.getElementById('processingLayer');
    els.success = document.getElementById('successLayer');
    els.formCard = document.querySelector('.auth-card');
    els.pinForm = document.getElementById('pinForm');
    
    gsap.set([els.manager, els.courier, els.tablet, els.orderCard, els.parcels, els.route, els.processing, els.success], { 
        transformOrigin: "50% 50%", 
        transformStyle: "preserve-3d" 
    });

    // Parallax logic via xPercent/yPercent and 3D rotation to avoid overriding x/y from timelines
    window.addEventListener("mousemove", (e) => {
        if (!parallaxEnabled) return;
        mouseX = (e.clientX / window.innerWidth) - 0.5;
        mouseY = (e.clientY / window.innerHeight) - 0.5;

        // Manager in foreground -> moves more
        gsap.to(els.manager, { xPercent: mouseX * -20, yPercent: mouseY * -10, duration: 1, ease: "power2.out" });
        // Route in background -> moves opposite
        gsap.to(els.route, { xPercent: mouseX * 10, yPercent: mouseY * 5, duration: 1, ease: "power2.out" });
        // Tablet 3D tilt
        gsap.to(els.tablet, { xPercent: mouseX * -15, rotationY: mouseX * 15, rotationX: mouseY * -15, duration: 1, ease: "power2.out" });
        // Order Card
        gsap.to(els.orderCard, { xPercent: mouseX * -25, yPercent: mouseY * -20, rotationY: mouseX * 20, duration: 1, ease: "power2.out" });
        // Parcels & Courier
        gsap.to(els.parcels, { xPercent: mouseX * -8, duration: 1, ease: "power2.out" });
        gsap.to(els.courier, { xPercent: mouseX * -12, yPercent: mouseY * -6, duration: 1, ease: "power2.out" });
    });
}

function killCurrent() {
    if (currentTimeline) {
        currentTimeline.kill();
        currentTimeline = null;
    }
}

export function playIntro() {
    initEls();
    killCurrent();
    
    gsap.set(els.manager, { opacity: 0, x: -50, scale: 0.9 });
    gsap.set(els.courier, { opacity: 0, x: 50, scale: 0.9 });
    gsap.set(els.tablet, { opacity: 0, scale: 0.8, rotationX: 45, rotationY: -20 });
    gsap.set(els.orderCard, { opacity: 0, y: -40, scale: 0.8, rotationZ: -10 });
    gsap.set(els.parcels, { opacity: 0, y: 40 });
    gsap.set(els.route, { opacity: 0, scale: 1.1 });
    gsap.set(els.processing, { opacity: 0 });
    gsap.set(els.success, { opacity: 0 });
    gsap.set(els.formCard, { opacity: 0, y: 20 });

    const tl = gsap.timeline({ onComplete: playIdle });
    currentTimeline = tl;

    // Utilisation de Back.easeOut pour une apparition plus rebondissante et organique
    tl.to(els.formCard, { opacity: 1, y: 0, duration: 1, ease: "power3.out" }, 0)
      .to(els.route, { opacity: 0.7, scale: 1, duration: 1.2, ease: "power2.out" }, 0.1)
      .to(els.manager, { opacity: 1, x: 0, scale: 1, duration: 1, ease: "back.out(1.2)" }, 0.2)
      .to(els.tablet, { opacity: 1, scale: 1, rotationX: 0, rotationY: 0, duration: 1.2, ease: "back.out(1.2)" }, 0.3)
      .to(els.orderCard, { opacity: 1, y: 0, scale: 1, rotationZ: 0, duration: 1, ease: "back.out(1.5)" }, 0.4)
      .to(els.parcels, { opacity: 1, y: 0, duration: 1, ease: "back.out(1.2)" }, 0.5)
      .to(els.courier, { opacity: 1, x: 0, scale: 1, duration: 1, ease: "back.out(1.2)" }, 0.6);
}

export function playIdle() {
    initEls();
    if (idleTimeline) idleTimeline.kill();
    
    idleTimeline = gsap.timeline({ repeat: -1, yoyo: true });
    
    idleTimeline
      .to(els.orderCard, { y: "+=5", rotationZ: "+=1", duration: 4, ease: "sine.inOut" }, 0)
      .to(els.tablet, { rotationZ: "-=0.5", y: "-=2", duration: 5, ease: "sine.inOut" }, 0)
      .to(els.parcels, { y: "-=3", duration: 4.5, ease: "sine.inOut" }, 0)
      .to(els.route, { opacity: 0.4, duration: 3, ease: "sine.inOut" }, 0)
      .to(els.manager, { y: "+=2", duration: 6, ease: "sine.inOut" }, 0);
}

export function playFocus() {
    initEls();
    killCurrent();
    
    if (idleTimeline) idleTimeline.pause();
    
    const tl = gsap.timeline();
    currentTimeline = tl;
    
    // Elastic ease for that snappy feel
    tl.to(els.tablet, { scale: 1.05, filter: "drop-shadow(0 10px 20px rgba(37,99,235,0.2))", duration: 0.8, ease: "elastic.out(1, 0.5)" }, 0)
      .to(els.orderCard, { x: 10, y: -6, rotationZ: 2, filter: "drop-shadow(0 8px 15px rgba(0,0,0,0.1))", duration: 0.8, ease: "elastic.out(1, 0.5)" }, 0)
      .to(els.manager, { x: 5, duration: 0.6, ease: "power2.out" }, 0)
      .to(els.parcels, { x: 5, duration: 0.6, ease: "power2.out" }, 0);
}

export function playDigitProgress(count) {
    initEls();
    killCurrent();
    
    if (count === 4) return;
    
    const tl = gsap.timeline();
    currentTimeline = tl;
    
    if (count === 0) {
        playFocus();
        return;
    }

    if (count === 1) {
        tl.to(els.orderCard, { x: 15, duration: 0.6, ease: "elastic.out(1, 0.7)" }, 0)
          .to(els.parcels, { y: -4, duration: 0.4, ease: "back.out(1.5)" }, 0)
          .to(els.route, { opacity: 0.8, duration: 0.3 }, 0);
    } 
    else if (count === 2) {
        tl.to(els.orderCard, { x: 22, y: -4, duration: 0.6, ease: "elastic.out(1, 0.7)" }, 0)
          .to(els.courier, { x: 8, duration: 0.4, ease: "back.out(1.5)" }, 0)
          .to(els.route, { opacity: 0.9, duration: 0.3 }, 0);
    } 
    else if (count === 3) {
        tl.to(els.parcels, { x: 12, duration: 0.6, ease: "elastic.out(1, 0.7)" }, 0)
          .to(els.tablet, { scale: 1.08, filter: "drop-shadow(0 15px 25px rgba(37,99,235,0.3))", duration: 0.6, ease: "elastic.out(1, 0.7)" }, 0)
          .to(els.route, { opacity: 1, filter: "brightness(1.1)", duration: 0.3 }, 0);
    }
}

export function playVerifying() {
    initEls();
    killCurrent();
    if (idleTimeline) idleTimeline.pause();
    
    if (verifyingTimeline) verifyingTimeline.kill();
    verifyingTimeline = gsap.timeline({ repeat: -1 });
    
    // Setup state
    gsap.set(els.processing, { opacity: 0, scale: 0.5, filter: "brightness(1)" });
    
    // Initial organic movement
    gsap.to(els.orderCard, { x: 30, y: -12, rotationY: 10, duration: 0.8, ease: "elastic.out(1, 0.6)" });
    gsap.to(els.tablet, { rotationZ: -2, scale: 1.05, duration: 0.8, ease: "elastic.out(1, 0.6)" });
    gsap.to(els.courier, { x: 12, duration: 0.8, ease: "power2.out" });
    
    // Pop the processing badge
    gsap.to(els.processing, { opacity: 1, scale: 1, duration: 0.5, ease: "back.out(2)" });
    
    // Looping advanced animation
    verifyingTimeline.to(els.processing, { scale: 1.1, filter: "brightness(1.2)", rotationZ: 3, duration: 0.6, yoyo: true, repeat: 1, ease: "sine.inOut" }, 0)
                     .to(els.route, { opacity: 0.7, filter: "brightness(1.2)", duration: 0.6, yoyo: true, repeat: 1, ease: "sine.inOut" }, 0)
                     .to(els.orderCard, { y: "-=3", rotationZ: 1, duration: 0.6, yoyo: true, repeat: 1, ease: "sine.inOut" }, 0)
                     .to(els.tablet, { filter: "drop-shadow(0 15px 30px rgba(37,99,235,0.4))", duration: 0.6, yoyo: true, repeat: 1, ease: "sine.inOut" }, 0);
}

export function playSuccess() {
    initEls();
    killCurrent();
    if (verifyingTimeline) verifyingTimeline.kill();
    
    parallaxEnabled = false; // Freeze parallax for clean exit
    
    const tl = gsap.timeline();
    currentTimeline = tl;
    
    tl.to(els.processing, { opacity: 0, scale: 0, duration: 0.3, ease: "back.in(1.5)" }, 0)
      .to(els.success, { opacity: 1, scale: 1.2, rotationZ: 360, duration: 0.6, ease: "back.out(1.5)" }, 0.2)
      .to(els.success, { scale: 1, duration: 0.3, ease: "power2.out" }, 0.8)
      
      // Order Card flips and slides into tablet
      .to(els.orderCard, { x: 45, y: -15, rotationY: 90, scale: 0.7, opacity: 0, duration: 0.5, ease: "power2.in" }, 0.1)
      
      // Tablet glows success green
      .to(els.tablet, { filter: "drop-shadow(0 0 40px rgba(16, 185, 129, 0.6))", scale: 1.1, duration: 0.5 }, 0.2)
      
      // Parcels and Courier drive off to the distance (scale down & move right)
      .to(els.parcels, { x: 100, scale: 0.5, opacity: 0, duration: 0.8, ease: "power3.in" }, 0.2)
      .to(els.courier, { x: 150, scale: 0.5, opacity: 0, duration: 0.8, ease: "power3.in" }, 0.2)
      
      // Route lights up
      .to(els.route, { opacity: 1, filter: "brightness(1.5) hue-rotate(-40deg)", duration: 0.4 }, 0.2)
      
      // Final transition out
      .to(els.manager, { opacity: 0, y: -20, duration: 0.4, ease: "power2.in" }, 1.2)
      .to(els.tablet, { opacity: 0, scale: 0.9, duration: 0.4, ease: "power2.in" }, 1.2)
      .to(els.route, { opacity: 0, duration: 0.4 }, 1.2)
      .to(els.success, { opacity: 0, scale: 0, duration: 0.3, ease: "back.in(2)" }, 1.2)
      .to(els.formCard, { opacity: 0, y: -40, duration: 0.5, ease: "power3.in" }, 1.4);
}

export function playError() {
    initEls();
    killCurrent();
    if (verifyingTimeline) verifyingTimeline.kill();
    
    const tl = gsap.timeline({
        onComplete: playFocus
    });
    currentTimeline = tl;
    
    // Pulse rouge sur la tablette et la carte de commande
    tl.to(els.processing, { opacity: 0, duration: 0.2 }, 0)
      .to(els.tablet, { filter: "drop-shadow(0 0 30px rgba(220, 38, 38, 0.6))", rotationZ: -4, x: -10, duration: 0.1, yoyo: true, repeat: 3 }, 0)
      .to(els.orderCard, { filter: "drop-shadow(0 0 15px rgba(220, 38, 38, 0.5))", rotationZ: -8, x: -20, duration: 0.1, yoyo: true, repeat: 3 }, 0)
      .to(els.manager, { x: -5, duration: 0.1, yoyo: true, repeat: 3 }, 0)
      .to(els.parcels, { x: -8, duration: 0.1, yoyo: true, repeat: 3 }, 0)
      .to(els.pinForm, { x: -10, duration: 0.05, yoyo: true, repeat: 5 }, 0)
      
      // Nettoyage du filtre après secousse
      .to([els.tablet, els.orderCard], { filter: "drop-shadow(0 0 0px rgba(0,0,0,0))", duration: 0.3 }, "+=0.1");
}

export function resetMotion() {
    initEls();
    killCurrent();
    if (idleTimeline) idleTimeline.kill();
    if (verifyingTimeline) verifyingTimeline.kill();
    parallaxEnabled = true;
    
    gsap.set([els.manager, els.courier, els.tablet, els.orderCard, els.parcels, els.route, els.processing, els.success], { clearProps: "all" });
    gsap.set([els.manager, els.courier, els.tablet, els.orderCard, els.parcels, els.route, els.processing, els.success], { transformOrigin: "50% 50%", transformStyle: "preserve-3d" });
    
    playIntro();
}

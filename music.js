// Procedural 16-bit lofi music engine. Extracted from monolithic HTML.
// Exposes MusicEngine — game.js consumes MusicEngine.init() / start() / setMuted().

// ═══════════════════════════════════════════════════════
// PROCEDURAL 16-BIT LOFI MUSIC ENGINE
// ═══════════════════════════════════════════════════════

// Multi-track music system — 3 distinct lofi tracks that crossfade
const TRACKS = [
    {
        name: "Chill Dungeon",
        bpm: 75,
        beatsPerChord: 2,
        progressions: [
            [[60,64,67,71], [57,60,64,67], [62,65,69,72], [55,59,62,65]], // Cmaj7→Am7→Dm7→G7
            [[65,69,72,76], [64,67,71,74], [57,60,64,67], [62,65,69,72]], // Fmaj7→Em7→Am7→Dm7
            [[62,65,69,72], [55,59,62,65], [60,64,67,71], [65,69,72,76]], // Dm7→G7→Cmaj7→Fmaj7
        ],
        scale: [60,62,64,67,69, 72,74,76,79,81], // C pentatonic
        chordWave: 'square', melodyWave: 'square', bassWave: 'triangle',
        melodyChance: 0.35, arpChance: 0.65,
        chordOctave: 12, chordGain: 0.007, chordSustain: 0.004,
        melodyGain: 0.045, bassGain: 0.065, arpGain: 0.018,
        halfTimeDrums: false, useDrone: false, busyHihats: false,
        rhythmicBass: false, swingAmount: 0.33
    },
    {
        name: "Deep Cavern",
        bpm: 65,
        beatsPerChord: 2,
        progressions: [
            [[62,65,69,72], [55,58,62,65], [58,62,65,69], [57,60,64,67]], // Dm7→Gm7→Bbmaj7→Am7
            [[62,66,69,72], [58,62,65,69], [55,58,62,66], [57,60,64,67]], // Dm9→Bbmaj7→Gm9→Am7
            [[57,60,64,67], [62,65,69,72], [58,62,65,69], [55,59,62,65]], // Am7→Dm7→Bbmaj7→G7
        ],
        scale: [62,65,67,69,72, 74,77,79,81,84], // D minor pentatonic (2 octaves)
        chordWave: 'sawtooth', melodyWave: 'triangle', bassWave: 'triangle',
        melodyChance: 0.22, arpChance: 0,
        chordOctave: 12, chordGain: 0.005, chordSustain: 0.003,
        melodyGain: 0.035, bassGain: 0.055, arpGain: 0,
        halfTimeDrums: true, useDrone: true, busyHihats: false,
        rhythmicBass: false, swingAmount: 0.20
    },
    {
        name: "Battle Groove",
        bpm: 85,
        beatsPerChord: 2,
        progressions: [
            [[57,60,64,67], [65,69,72,76], [60,64,67,71], [64,67,71,74]], // Am7→Fmaj7→Cmaj7→Em7
            [[57,60,64,67], [62,65,69,72], [65,69,72,76], [60,64,67,71]], // Am7→Dm7→Fmaj7→Cmaj7
            [[64,67,71,74], [57,60,64,67], [62,65,69,72], [55,59,62,65]], // Em7→Am7→Dm7→G7
        ],
        scale: [57,60,62,64,67, 69,72,74,76,79], // A minor pentatonic (2 octaves)
        chordWave: 'square', melodyWave: 'square', bassWave: 'triangle',
        melodyChance: 0.50, arpChance: 0.70,
        chordOctave: 12, chordGain: 0.006, chordSustain: 0.004,
        melodyGain: 0.040, bassGain: 0.060, arpGain: 0.015,
        halfTimeDrums: false, useDrone: false, busyHihats: true,
        rhythmicBass: true, swingAmount: 0.25
    }
];

const MusicEngine = {
    audioCtx: null,
    masterGain: null,
    lofiFilter: null,
    noiseBuffer: null,
    layerGains: {},
    isMuted: false,
    volume: 0.12,
    state: {
        isPlaying: false,
        schedulerInterval: null,
        nextEighthTime: 0,
        currentEighth: 0,       // 0-31 (4 chords × 4 beats × 2 eighths)
        currentProgression: 0,
        loopCount: 0,
        lastMelodyNote: 67,
        arpIndex: 0,
        arpActive: true,
        activeChordOscs: [],
        currentTrack: 0,
        loopsBeforeSwitch: 4,
        crossfading: false,
        crossfadeTimeout: null,
    },

    _midiToFreq(note) {
        return 440 * Math.pow(2, (note - 69) / 12);
    },

    _createNoiseBuffer() {
        // Crunchy 16-bit style noise: sample-and-hold at reduced rate for gritty texture
        const sr = this.audioCtx.sampleRate;
        const buf = this.audioCtx.createBuffer(1, sr, sr);
        const data = buf.getChannelData(0);
        const holdSamples = 4; // hold each random value for 4 samples (effective ~11kHz)
        const quantLevels = 48; // quantize amplitude to fewer levels
        let val = 0;
        for (let i = 0; i < sr; i++) {
            if (i % holdSamples === 0) {
                val = Math.round((Math.random() * 2 - 1) * quantLevels) / quantLevels;
            }
            data[i] = val;
        }
        this.noiseBuffer = buf;
    },

    init() {
        if (this.audioCtx) return;
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();

        // Create lofi low-pass filter
        this.lofiFilter = this.audioCtx.createBiquadFilter();
        this.lofiFilter.type = 'lowpass';
        this.lofiFilter.frequency.value = 3500;
        this.lofiFilter.Q.value = 0.7;

        // Master volume
        this.masterGain = this.audioCtx.createGain();
        this.masterGain.gain.value = this.volume;

        // Connect: filter → master → output
        this.lofiFilter.connect(this.masterGain);
        this.masterGain.connect(this.audioCtx.destination);

        // Layer gain nodes
        const layers = ['chords', 'bass', 'melody', 'drums', 'arp'];
        layers.forEach(name => {
            const g = this.audioCtx.createGain();
            g.gain.value = 1;
            g.connect(this.lofiFilter);
            this.layerGains[name] = g;
        });

        // 16-bit drum processing chain: drums → bitcrush → resonance → lofiFilter
        // Reconnect drums through the crush chain instead of straight to lofiFilter
        this.layerGains.drums.disconnect();
        this.layerGains.drums.gain.value = 1.3; // slight volume boost

        // Bitcrusher waveshaper — quantizes signal to stepped levels like 16-bit samples
        const crushCurve = new Float32Array(1024);
        const steps = 32; // quantization steps (lower = crunchier)
        for (let i = 0; i < 1024; i++) {
            const x = (i / 1023) * 2 - 1; // -1 to 1
            crushCurve[i] = Math.round(x * steps) / steps;
        }
        this.drumCrush = this.audioCtx.createWaveShaper();
        this.drumCrush.curve = crushCurve;
        this.drumCrush.oversample = 'none'; // no smoothing = crunchier

        // Resonant peak gives that classic chip-tune percussion "ping"
        this.drumResonance = this.audioCtx.createBiquadFilter();
        this.drumResonance.type = 'peaking';
        this.drumResonance.frequency.value = 4000;
        this.drumResonance.Q.value = 1.5;
        this.drumResonance.gain.value = 3; // subtle 3dB boost at 4kHz

        // Chain: drums layer → bitcrush → resonance → lofi filter
        this.layerGains.drums.connect(this.drumCrush);
        this.drumCrush.connect(this.drumResonance);
        this.drumResonance.connect(this.lofiFilter);

        // Create shared noise buffer for drums (stepped for 16-bit feel)
        this._createNoiseBuffer();

        // Pick random starting track and progression
        this.state.currentTrack = Math.floor(Math.random() * TRACKS.length);
        const track = TRACKS[this.state.currentTrack];
        this.state.currentProgression = Math.floor(Math.random() * track.progressions.length);
        this.state.lastMelodyNote = track.scale[Math.floor(track.scale.length / 2)]; // start melody in middle of scale
    },

    start() {
        if (this.state.isPlaying) return;
        if (this.audioCtx.state === 'suspended') {
            this.audioCtx.resume();
        }
        this.state.isPlaying = true;
        this.state.nextEighthTime = this.audioCtx.currentTime + 0.1;
        this.state.currentEighth = 0;
        this.state.loopCount = 0;
        this.state.crossfading = false;
        const track = TRACKS[this.state.currentTrack];
        this.state.arpActive = Math.random() < (track.arpChance || 0.65);

        this.state.schedulerInterval = setInterval(() => this._schedulerTick(), 50);
    },

    stop() {
        this.state.isPlaying = false;
        this.state.crossfading = false;
        if (this.state.crossfadeTimeout) {
            clearTimeout(this.state.crossfadeTimeout);
            this.state.crossfadeTimeout = null;
        }
        if (this.state.schedulerInterval) {
            clearInterval(this.state.schedulerInterval);
            this.state.schedulerInterval = null;
        }
        // Fade out smoothly
        if (this.masterGain) {
            this.masterGain.gain.setTargetAtTime(0, this.audioCtx.currentTime, 0.1);
        }
        // Stop any sustained chord oscillators
        this.state.activeChordOscs.forEach(o => {
            try { o.stop(this.audioCtx.currentTime + 0.15); } catch(e) {}
        });
        this.state.activeChordOscs = [];
    },

    toggleMute() {
        this.isMuted = !this.isMuted;
        if (this.masterGain) {
            this.masterGain.gain.setTargetAtTime(
                this.isMuted ? 0 : this.volume,
                this.audioCtx.currentTime,
                0.05
            );
        }
        const btn = document.getElementById('music-toggle');
        if (btn) {
            btn.textContent = this.isMuted ? '♪ OFF' : '♪ ON';
            btn.classList.toggle('muted', this.isMuted);
        }
    },

    _schedulerTick() {
        if (!this.state.isPlaying || this.state.crossfading) return;
        const track = TRACKS[this.state.currentTrack];
        const eighthDuration = (60 / track.bpm) / 2;
        const lookAhead = 0.12;

        while (this.state.nextEighthTime < this.audioCtx.currentTime + lookAhead) {
            const time = this.state.nextEighthTime;
            const eighth = this.state.currentEighth;
            const totalEighths = track.beatsPerChord * 2;
            const chordIdx = Math.floor(eighth / totalEighths) % 4;
            const beatInChord = eighth % totalEighths;
            const prog = track.progressions[this.state.currentProgression];
            const chord = prog[chordIdx];

            // === CHORDS (pad) — play on first eighth of each chord ===
            if (beatInChord === 0) {
                this._scheduleChord(time, chord, eighthDuration * totalEighths);
            }

            // === BASS ===
            if (track.rhythmicBass) {
                // Rhythmic eighth-note bass for Battle Groove
                if (beatInChord % 2 === 0) {
                    this._scheduleBass(time, chord[0] - 12, eighthDuration * 0.9);
                } else if (Math.random() < 0.4) {
                    this._scheduleBass(time, chord[0] - 12, eighthDuration * 0.6, 0.6);
                }
            } else {
                // Standard bass on beats 1 and 3
                if (beatInChord === 0 || beatInChord === 4) {
                    this._scheduleBass(time, chord[0] - 12, eighthDuration * 1.5);
                }
            }

            // === DRONE (Deep Cavern only) ===
            if (track.useDrone && beatInChord === 0 && chordIdx === 0) {
                this._scheduleDrone(time, chord[0] - 24, eighthDuration * totalEighths * 4);
            }

            // === DRUMS ===
            const swingAmt = eighthDuration * (track.swingAmount || 0.33);

            if (track.halfTimeDrums) {
                // Half-time: kick on 1 only, snare on 3 only, slow open hats
                if (beatInChord === 0) this._scheduleKick(time);
                if (beatInChord === 4) this._scheduleSnare(time);
                // Slow open hats on 1 and 3
                if (beatInChord === 0 || beatInChord === 4) {
                    this._scheduleHiHatOpen(time);
                }
                // Occasional closed hat fill
                if (beatInChord === 6 && Math.random() < 0.25) {
                    this._scheduleHiHat(time);
                }
            } else {
                // Standard or busy drums
                if (beatInChord === 0 || beatInChord === 4) this._scheduleKick(time);
                if (beatInChord === 2 || beatInChord === 6) {
                    this._scheduleSnare(time);
                } else if (beatInChord === 5 && Math.random() < 0.3) {
                    this._scheduleSnare(time, 0.35);
                }

                if (track.busyHihats) {
                    // 16th-note hihats for Battle Groove
                    this._scheduleHiHat(time);
                    if (Math.random() < 0.6) {
                        this._scheduleHiHat(time + eighthDuration * 0.5, 0.5); // ghost 16th
                    }
                    // Sidestick on upbeats
                    if (beatInChord % 2 === 1 && Math.random() < 0.4) {
                        this._scheduleSidestick(time + swingAmt);
                    }
                } else {
                    // Standard swung hihats
                    if (beatInChord % 2 === 0) {
                        this._scheduleHiHat(time);
                    } else {
                        this._scheduleHiHatOpen(time + swingAmt);
                    }
                }

                // Triplet fills
                const tripletChance = (beatInChord === 6) ? 0.15 : (beatInChord === 2) ? 0.08 : 0;
                if (tripletChance > 0 && Math.random() < tripletChance) {
                    this._scheduleTripletFill(time, eighthDuration);
                }
            }

            // === MELODY ===
            if (Math.random() < track.melodyChance) {
                this._scheduleMelody(time, eighthDuration * (1 + Math.random()));
            }

            // === ARPEGGIO ===
            if (this.state.arpActive && track.arpChance > 0) {
                this._scheduleArp(time, chord, eighthDuration * 0.8);
            }

            // Advance
            this.state.nextEighthTime += eighthDuration;
            this.state.currentEighth++;

            // Loop back after full progression
            const totalEighthsInLoop = 4 * track.beatsPerChord * 2;
            if (this.state.currentEighth >= totalEighthsInLoop) {
                this.state.currentEighth = 0;
                this.state.loopCount++;
                // Randomly toggle arp and maybe change progression
                this.state.arpActive = Math.random() < (track.arpChance || 0.65);
                if (this.state.loopCount % 3 === 0) {
                    this.state.currentProgression = Math.floor(Math.random() * track.progressions.length);
                }
                // Check for track switch
                if (this.state.loopCount >= this.state.loopsBeforeSwitch) {
                    this._crossfadeToNext();
                }
            }
        }
    },

    _scheduleChord(time, notes, duration) {
        const track = TRACKS[this.state.currentTrack];
        // Fade out old chord oscillators
        this.state.activeChordOscs.forEach(o => {
            try {
                o.gainNode.gain.setTargetAtTime(0, time, 0.15);
                o.osc.stop(time + 0.4);
            } catch(e) {}
        });
        this.state.activeChordOscs = [];

        notes.forEach(note => {
            const osc = this.audioCtx.createOscillator();
            const gain = this.audioCtx.createGain();

            osc.type = track.chordWave;
            osc.frequency.value = this._midiToFreq(note + track.chordOctave);
            osc.detune.value = (Math.random() - 0.5) * 16;

            gain.gain.setValueAtTime(0, time);
            gain.gain.linearRampToValueAtTime(track.chordGain, time + 0.1);
            gain.gain.setTargetAtTime(track.chordSustain, time + 0.1, 0.3);

            osc.connect(gain);
            gain.connect(this.layerGains.chords);
            osc.start(time);
            osc.stop(time + duration + 0.5);
            osc.onended = () => { osc.disconnect(); gain.disconnect(); };

            this.state.activeChordOscs.push({ osc, gainNode: gain });
        });
    },

    _scheduleBass(time, note, duration, velMult) {
        const track = TRACKS[this.state.currentTrack];
        const v = velMult || 1.0;
        const osc = this.audioCtx.createOscillator();
        const gain = this.audioCtx.createGain();

        osc.type = track.bassWave;
        osc.frequency.value = this._midiToFreq(note);
        osc.detune.value = (Math.random() - 0.5) * 8;

        gain.gain.setValueAtTime(0, time);
        gain.gain.linearRampToValueAtTime(track.bassGain * v, time + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.01, time + duration);

        osc.connect(gain);
        gain.connect(this.layerGains.bass);
        osc.start(time);
        osc.stop(time + duration + 0.02);
        osc.onended = () => { osc.disconnect(); gain.disconnect(); };
    },

    _scheduleMelody(time, duration) {
        const track = TRACKS[this.state.currentTrack];
        const scale = track.scale;
        const last = this.state.lastMelodyNote;
        const nearby = scale.filter(n => Math.abs(n - last) <= 5);
        const pool = nearby.length > 0 ? nearby : scale;
        const note = pool[Math.floor(Math.random() * pool.length)];
        this.state.lastMelodyNote = note;

        const osc = this.audioCtx.createOscillator();
        const gain = this.audioCtx.createGain();

        osc.type = track.melodyWave;
        osc.frequency.value = this._midiToFreq(note);
        osc.detune.value = (Math.random() - 0.5) * 12;

        gain.gain.setValueAtTime(0, time);
        gain.gain.linearRampToValueAtTime(track.melodyGain, time + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.001, time + duration);

        osc.connect(gain);
        gain.connect(this.layerGains.melody);
        osc.start(time);
        osc.stop(time + duration + 0.02);
        osc.onended = () => { osc.disconnect(); gain.disconnect(); };
    },

    _scheduleKick(time) {
        // 16-bit kick: square wave pitch sweep for that retro thump
        const osc = this.audioCtx.createOscillator();
        const gain = this.audioCtx.createGain();

        osc.type = 'square'; // square wave = more harmonics = chip-tune punch
        osc.frequency.setValueAtTime(160, time);
        osc.frequency.exponentialRampToValueAtTime(35, time + 0.08); // faster sweep

        gain.gain.setValueAtTime(0.10, time);
        gain.gain.exponentialRampToValueAtTime(0.001, time + 0.12);

        osc.connect(gain);
        gain.connect(this.layerGains.drums);
        osc.start(time);
        osc.stop(time + 0.15);
        osc.onended = () => { osc.disconnect(); gain.disconnect(); };

        // Sharp click transient — classic SNES-style attack
        const click = this.audioCtx.createOscillator();
        const clickGain = this.audioCtx.createGain();
        click.type = 'square';
        click.frequency.value = 1000;
        clickGain.gain.setValueAtTime(0.05, time);
        clickGain.gain.exponentialRampToValueAtTime(0.001, time + 0.008); // snappier
        click.connect(clickGain);
        clickGain.connect(this.layerGains.drums);
        click.start(time);
        click.stop(time + 0.02);
        click.onended = () => { click.disconnect(); clickGain.disconnect(); };
    },

    _scheduleSnare(time, velMult) {
        // 16-bit snare: crunchy noise burst + square wave body for retro snap
        const v = velMult || 1.0;
        const noise = this.audioCtx.createBufferSource();
        const noiseGain = this.audioCtx.createGain();
        const noiseFilter = this.audioCtx.createBiquadFilter();

        noise.buffer = this.noiseBuffer;
        noiseFilter.type = 'highpass';
        noiseFilter.frequency.value = 2500; // higher cutoff for crispier texture
        noiseGain.gain.setValueAtTime(0.07 * v, time);
        noiseGain.gain.exponentialRampToValueAtTime(0.001, time + 0.10 * v);

        noise.connect(noiseFilter);
        noiseFilter.connect(noiseGain);
        noiseGain.connect(this.layerGains.drums);
        noise.start(time);
        noise.stop(time + 0.13);
        noise.onended = () => { noise.disconnect(); noiseFilter.disconnect(); noiseGain.disconnect(); };

        // Square wave body — pitched snap like SNES percussion
        const osc = this.audioCtx.createOscillator();
        const oscGain = this.audioCtx.createGain();
        osc.type = 'square';
        osc.frequency.setValueAtTime(220, time);
        osc.frequency.exponentialRampToValueAtTime(120, time + 0.04); // slight pitch drop
        oscGain.gain.setValueAtTime(0.045 * v, time);
        oscGain.gain.exponentialRampToValueAtTime(0.001, time + 0.06);
        osc.connect(oscGain);
        oscGain.connect(this.layerGains.drums);
        osc.start(time);
        osc.stop(time + 0.08);
        osc.onended = () => { osc.disconnect(); oscGain.disconnect(); };
    },

    _scheduleHiHat(time, velMult) {
        const v = velMult || 1.0;
        const noise = this.audioCtx.createBufferSource();
        const gain = this.audioCtx.createGain();
        const filter = this.audioCtx.createBiquadFilter();

        noise.buffer = this.noiseBuffer;
        filter.type = 'highpass';
        filter.frequency.value = 7000;
        gain.gain.setValueAtTime(0.025 * v, time);
        gain.gain.exponentialRampToValueAtTime(0.001, time + 0.03);

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(this.layerGains.drums);
        noise.start(time);
        noise.stop(time + 0.05);
        noise.onended = () => { noise.disconnect(); filter.disconnect(); gain.disconnect(); };
    },

    _scheduleHiHatOpen(time) {
        // Open hi-hat: longer, brighter, slightly louder — gives the swing feel
        const noise = this.audioCtx.createBufferSource();
        const gain = this.audioCtx.createGain();
        const filter = this.audioCtx.createBiquadFilter();

        noise.buffer = this.noiseBuffer;
        filter.type = 'highpass';
        filter.frequency.value = 5500;
        filter.Q.value = 0.8;
        gain.gain.setValueAtTime(0.03, time);
        gain.gain.exponentialRampToValueAtTime(0.001, time + 0.12);

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(this.layerGains.drums);
        noise.start(time);
        noise.stop(time + 0.15);
        noise.onended = () => { noise.disconnect(); filter.disconnect(); gain.disconnect(); };
    },

    _scheduleTripletFill(time, eighthDuration) {
        // Triplet fill: 3 quick hits over the space of one beat (2 eighths)
        // Creates a ta-ka-ta swing triplet feel
        const tripletSpacing = (eighthDuration * 2) / 3; // divide one beat into 3

        // Hit 1: hi-hat (already playing on the beat, so start from +1 triplet)
        // Hit 2: ghost snare
        this._scheduleSnare(time + tripletSpacing, 0.25);
        // Hit 3: hi-hat tap
        this._scheduleHiHat(time + tripletSpacing * 2);

        // Occasionally add a kick on the last triplet for weight (40% chance)
        if (Math.random() < 0.4) {
            this._scheduleKick(time + tripletSpacing * 2);
        }
    },

    _scheduleArp(time, chordNotes, duration) {
        const idx = this.state.arpIndex % (chordNotes.length * 2 - 2);
        // Bounce: 0,1,2,3,2,1 pattern
        let noteIdx;
        if (idx < chordNotes.length) {
            noteIdx = idx;
        } else {
            noteIdx = chordNotes.length * 2 - 2 - idx;
        }
        this.state.arpIndex++;

        const osc = this.audioCtx.createOscillator();
        const gain = this.audioCtx.createGain();

        osc.type = 'triangle';
        osc.frequency.value = this._midiToFreq(chordNotes[noteIdx] + 12);
        osc.detune.value = (Math.random() - 0.5) * 10;

        const track = TRACKS[this.state.currentTrack];
        gain.gain.setValueAtTime(0, time);
        gain.gain.linearRampToValueAtTime(track.arpGain || 0.018, time + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.001, time + duration);

        osc.connect(gain);
        gain.connect(this.layerGains.arp);
        osc.start(time);
        osc.stop(time + duration + 0.02);
        osc.onended = () => { osc.disconnect(); gain.disconnect(); };
    },

    _scheduleDrone(time, note, duration) {
        // Sub-bass drone — very low sine wave with slow pulse for Deep Cavern track
        const osc = this.audioCtx.createOscillator();
        const gain = this.audioCtx.createGain();

        osc.type = 'sine';
        osc.frequency.value = this._midiToFreq(note);

        // Slow swell in and out
        gain.gain.setValueAtTime(0, time);
        gain.gain.linearRampToValueAtTime(0.04, time + duration * 0.3);
        gain.gain.setTargetAtTime(0.025, time + duration * 0.3, duration * 0.2);
        gain.gain.setTargetAtTime(0, time + duration * 0.8, 0.3);

        osc.connect(gain);
        gain.connect(this.layerGains.bass);
        osc.start(time);
        osc.stop(time + duration + 0.5);
        osc.onended = () => { osc.disconnect(); gain.disconnect(); };
    },

    _scheduleSidestick(time) {
        // Short pitched click — like a rim shot / sidestick for Battle Groove
        const osc = this.audioCtx.createOscillator();
        const gain = this.audioCtx.createGain();

        osc.type = 'square';
        osc.frequency.setValueAtTime(800, time);
        osc.frequency.exponentialRampToValueAtTime(400, time + 0.015);

        gain.gain.setValueAtTime(0.035, time);
        gain.gain.exponentialRampToValueAtTime(0.001, time + 0.025);

        osc.connect(gain);
        gain.connect(this.layerGains.drums);
        osc.start(time);
        osc.stop(time + 0.04);
        osc.onended = () => { osc.disconnect(); gain.disconnect(); };
    },

    _crossfadeToNext() {
        if (this.state.crossfading || !this.state.isPlaying) return;
        this.state.crossfading = true;

        const fadeTime = 3.0; // 3-second crossfade
        const now = this.audioCtx.currentTime;

        // Fade out current track
        this.masterGain.gain.cancelScheduledValues(now);
        this.masterGain.gain.setValueAtTime(this.isMuted ? 0 : this.volume, now);
        this.masterGain.gain.linearRampToValueAtTime(0, now + fadeTime);

        // Stop chord oscillators at end of fade
        this.state.activeChordOscs.forEach(o => {
            try { o.gainNode.gain.setTargetAtTime(0, now + fadeTime * 0.8, 0.2); o.osc.stop(now + fadeTime + 0.3); } catch(e) {}
        });

        // After fade out, switch track and fade back in
        this.state.crossfadeTimeout = setTimeout(() => {
            if (!this.state.isPlaying) return;

            // Advance to next track
            this.state.currentTrack = (this.state.currentTrack + 1) % TRACKS.length;
            const newTrack = TRACKS[this.state.currentTrack];

            // Reset scheduler state for new track
            this.state.currentEighth = 0;
            this.state.loopCount = 0;
            this.state.currentProgression = Math.floor(Math.random() * newTrack.progressions.length);
            this.state.lastMelodyNote = newTrack.scale[Math.floor(newTrack.scale.length / 2)];
            this.state.arpIndex = 0;
            this.state.arpActive = Math.random() < (newTrack.arpChance || 0.65);
            this.state.activeChordOscs = [];
            this.state.nextEighthTime = this.audioCtx.currentTime + 0.05;

            // Fade in new track
            const fadeInNow = this.audioCtx.currentTime;
            this.masterGain.gain.cancelScheduledValues(fadeInNow);
            this.masterGain.gain.setValueAtTime(0, fadeInNow);
            this.masterGain.gain.linearRampToValueAtTime(this.isMuted ? 0 : this.volume, fadeInNow + fadeTime * 0.8);

            this.state.crossfading = false;
        }, fadeTime * 1000);
    },
};

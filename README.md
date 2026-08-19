# Nikkiro Audio Visualizer 🎵

[![GitHub license](https://shields.io)](https://github.com/koyboiii-coder/Nikkiro-Audio-Visualizer)
[![GitHub stars](https://shields.io)](https://github.com)

Nikkiro Audio Visualizer is an advanced, **3D audio-reactive music visualizer** built with **Three.js**, **WebGL**, and **Electron**. It simulates a metallic, spiky fluid blob using custom GLSL shaders (3D Worley noise) that reacts in real-time to audio. Features include a transparent **desktop widget mode**, 13 color presets, and multiple audio input modes.

## ✨ Core Features
*   **3D Ferrofluid Simulation:** Real-time, spiky, high-contrast visualizer using `MeshPhysicalMaterial` and custom GLSL vertex shaders.
*   **Audio Reactivity:** Visualizes audio via microphone, file, or system audio capture.
*   **Desktop Widget (Electron):** Always-on-top, frameless window with system tray integration.
*   **Performance:** Optimized with Vite, featuring custom styling with CSS.

## 🚀 Getting Started

1.  **Clone & Install:** `npm install`
2.  **Web Mode:** `npm run dev` (Runs on `http://localhost:5173`)
3.  **Desktop Mode:** `npm run electron:dev`
4.  **Build:** `npm run dist` (Generates a Windows executable in `/release`)

*Note: In Electron mode, close the app via the system tray icon.*

## 📂 Project Structure
*   `src/`: Main Three.js setup (`main.js`), audio processing (`audio.js`), and shaders (`shaders.js`).
*   `electron/`: Main process and setup files.
*   `index.html`: Entry point with CSS control panel.

## 🎛️ Controls
Configure `Audio Source`, `Colors`, `Sensitivity`, `Smoothing`, `Spike Density`, `Sharpness`, `Rotation`, `Bloom`, and `Background Flow` from the integrated control panel.

## 📄 License
MIT

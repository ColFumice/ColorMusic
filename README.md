# Neuro（demo）

Neuro（demo） is an interactive image-to-sound instrument for Android. Choose an image, then touch or slide across it to play tones derived from each pixel's position and RGB color. The repository and application ID remain `ColorMusic` / `com.colormusic.game` for upgrade compatibility.

## Release

- Current release: **1.5**
- Platform: **Android only**
- Resolution: **automatically adapted**; tested on `2944 x 1840` tablets and `2800 x 1260` phones
- Recommended architecture: `arm64-v8a`
- Application ID: `com.colormusic.game`

The first launch defaults to **English**. Use the flag button in the top-right menu to switch between English and Chinese; the selection is saved locally for subsequent launches.

## Features

- Position-aware performance: horizontal position controls pitch and vertical position controls volume.
- RGB-driven timbre synthesis with independent R/G/B wavetable editing.
- A 29-sample drum library covering TR-808, TR-909, TR-606 / RD-6, acoustic, Boom-Bap, Trap, Lo-fi, and special percussion.
- Per-channel drum waveform preview with real-time volume and playback-speed shaping through the existing effect chains.
- Touch, hold, multi-touch, and slide performance with continuous pitch updates.
- Configurable grid with pitch/volume rulers, colors, opacity, density, edge gestures, minimum line visibility, and adaptive ruler typography.
- Per-channel global effect chains plus four final output effect slots.
- Built-in presets, random generation, undo/reset, calibration, and an in-app bilingual guide.
- Responsive landscape and portrait layouts that preserve button and text proportions.
- Native Android `AudioTrack` synthesis with WebAudio fallback for editor/browser preview.
- Recording plus a 13-track timeline editor with drag-and-drop blocks, mute/solo, snapping, automation, trim, speed, color, WAV export, and Android MP3 export.
- Configurable time-signature/BPM metronome with monitor-only clicks that are excluded from recordings.
- Style and style-flow management with preview, rename, clone, delete, import, export, and timed transitions.
- Automatic resolution-aware landscape UI spacing and typography.
- An immersive UI lock that leaves only the performance grid and unlock control visible.

## Requirements

ColorMusic is intended to run on Android devices. The included native audio bridge, system image picker, and touch layout are not supported on iOS, desktop, or other platforms.

For building from source:

- Cocos Creator 3.8.8
- Android SDK and NDK 23.2.8568313
- JDK 17
- Gradle wrapper included in the generated Android project

## Build Android

From the project directory, configure the Android paths in `.tooling/build-android.json`, then run:

```powershell
$env:JAVA_HOME = 'C:\Path\To\JDK17'
& 'C:\Path\To\CocosCreator.exe' `
  --project (Get-Location).Path `
  --build 'platform=android;configPath=.tooling/build-android.json' `
  --nologin
```

The generated Android project is under `build/android`. To assemble the debug APK directly:

```powershell
Set-Location build/android/proj
& .\gradlew.bat ':ColorMusic:assembleDebug' --no-daemon --console=plain
```

The APK is generated at:

`build/android/proj/build/ColorMusic/outputs/apk/debug/ColorMusic-debug.apk`

Install it on a USB-debugging Android device with:

```powershell
& 'C:\Path\To\adb.exe' install -r `
  'build/android/proj/build/ColorMusic/outputs/apk/debug/ColorMusic-debug.apk'
```

### MT 管理器便捷化设置教程

1. 安装并打开 MT 管理器，确认游戏已至少启动过一次。
2. 在 MT 左侧栏右上角点击“添加本地存储”，选择应用 `Neuro（demo）`（包名为 `com.colormusic.game`）。
3. 进入 `android_data/files/ColorMusic`。这里是游戏文件根目录，录音、导出的 WAV/MP3、样式和样式流数据包都在这里。
4. 游戏中的导出成功提示可点击“查看目录”返回 MT；若 MT 版本只打开首页，请从左侧的 `ColorMusic` 本地存储进入上述目录。
5. 分享文件时长按文件选择“分享”或“复制”。不要删除 `audio_*.wav` 文件，否则混音台中对应的录音片段会失效。

### Direct APK installation

ADB is optional. You can also install the release package directly:

1. Download `Neuro-demo-1.5-arm64-v8a.apk` from the [v1.5 release](https://github.com/ColFumice/ColorMusic/releases/tag/v1.5) on the Android device, or transfer the APK to the device over USB, cloud storage, or a messaging app.
2. Open the APK in the device's file manager and confirm **Install**.
3. If Android blocks the installation, enable **Allow from this source** for the file manager or browser when prompted, then retry.

The package is signed as a debug APK for this release build. Android may ask you to uninstall a package signed with a different key before installing it.

## Project layout

```text
assets/scripts/GameManager.ts       Main UI, touch mapping, image performance
assets/scripts/NativeBridge.ts      JS/native bridge and WebAudio fallback
assets/scripts/DrumLibrary.ts       Drum-kit catalog and waveform metadata
assets/scripts/SynthMapping.ts      Position and color to sound mapping
assets/scripts/GridSettings.ts      Grid configuration UI and persistence
assets/scripts/FxUI.ts              Wavetable and effect-chain UI
native/engine/android/app/src/...   Android activity, bridge, and AudioTrack synth
native/engine/android/app/drum-assets Bundled redistributable drum samples
.tooling/build-android.json         Reproducible Android build configuration
```

## Controls

1. Open the round menu and choose an image.
2. Touch the image to play; hold and slide for a sustained, continuous note.
3. Open **Settings** for Wavetable, Grid, and Output FX configuration.
4. Open **How to Play** for the in-app reference guide.
5. Use **Calibrate** if the device orientation or touch mapping needs correction.

## Versioning

The repository publishes releases **1.0**, **1.1**, **1.2**, **1.3**, **1.4**, and **1.5**. Releases 1.0 and 1.1 are preserved as the APK archives supplied for those versions; active source documentation follows the current 1.5 tree.

## License

No open-source license has been selected yet. Until a license is added, all rights are reserved by the copyright holder.

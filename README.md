# ColorMusic

ColorMusic is an interactive image-to-sound instrument for Android. Choose an image, then touch or slide across it to play tones derived from each pixel's position and RGB color.

## Release

- Current release: **1.2**
- Platform: **Android only**
- Best target resolution: **2944 x 1940**
- Recommended architecture: `arm64-v8a`
- Application ID: `com.colormusic.game`

The first launch defaults to **English**. Use the flag button in the top-right menu to switch between English and Chinese; the selection is saved locally for subsequent launches.

## Features

- Position-aware performance: horizontal position controls pitch and vertical position controls volume.
- RGB-driven timbre synthesis with independent R/G/B wavetable editing.
- Touch, hold, multi-touch, and slide performance with continuous pitch updates.
- Configurable grid with pitch/volume rulers, colors, opacity, density, and edge gestures.
- Per-channel global effect chains plus four final output effect slots.
- Built-in presets, random generation, undo/reset, calibration, and an in-app bilingual guide.
- Responsive landscape and portrait layouts that preserve button and text proportions.
- Native Android `AudioTrack` synthesis with WebAudio fallback for editor/browser preview.

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

### Direct APK installation

ADB is optional. You can also install the release package directly:

1. Download `ColorMusic-1.2-arm64-v8a.apk` from the [v1.2 release](https://github.com/ColFumice/ColorMusic/releases/tag/v1.2) on the Android device, or transfer the APK to the device over USB, cloud storage, or a messaging app.
2. Open the APK in the device's file manager and confirm **Install**.
3. If Android blocks the installation, enable **Allow from this source** for the file manager or browser when prompted, then retry.

The package is signed as a debug APK for this release build. Android may ask you to uninstall a package signed with a different key before installing it.

## Project layout

```text
assets/scripts/GameManager.ts       Main UI, touch mapping, image performance
assets/scripts/NativeBridge.ts      JS/native bridge and WebAudio fallback
assets/scripts/SynthMapping.ts      Position and color to sound mapping
assets/scripts/GridSettings.ts      Grid configuration UI and persistence
assets/scripts/FxUI.ts              Wavetable and effect-chain UI
native/engine/android/app/src/...   Android activity, bridge, and AudioTrack synth
.tooling/build-android.json         Reproducible Android build configuration
```

## Controls

1. Open the round menu and choose an image.
2. Touch the image to play; hold and slide for a sustained, continuous note.
3. Open **Settings** for Wavetable, Grid, and Output FX configuration.
4. Open **How to Play** for the in-app reference guide.
5. Use **Calibrate** if the device orientation or touch mapping needs correction.

## Versioning

This repository represents release **1.2**. Earlier releases **1.0** and **1.1** are intentionally left for separate upload.

## License

No open-source license has been selected yet. Until a license is added, all rights are reserved by the copyright holder.

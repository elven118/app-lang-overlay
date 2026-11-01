const path = require("node:path");
const CopyWebpackPlugin = require("copy-webpack-plugin");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const baseConfig = {
  mode: "production",
  devtool: "source-map",
  resolve: {
    extensions: [".ts", ".js"],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: "ts-loader",
      },
    ],
  },
  output: {
    path: path.resolve(__dirname, "dist"),
    clean: false,
  },
};

const mainConfig = {
  name: "main",
  ...baseConfig,
  target: "electron-main",
  externals: {
    ws: "commonjs ws",
  },
  entry: {
    main: "./src/main.ts",
  },
  plugins: [{ apply(compiler) {
    compiler.hooks.afterEmit.tap('BuildNativeHelpers', () => {
      if (process.platform === 'win32') {
        const output = path.join(__dirname, 'dist/native/windows');
        fs.mkdirSync(output, { recursive: true });
        fs.copyFileSync(path.join(__dirname, 'native/windows/window-picker.ps1'), path.join(output, 'window-picker.ps1'));
      }
      if (process.platform !== 'darwin') return;
      const output = path.join(__dirname, 'dist/native/macos');
      fs.mkdirSync(output, { recursive: true });
      execFileSync('xcrun', ['clang', '-fobjc-arc', '-O2',
        path.join(__dirname, 'native/macos/window-picker.m'), '-framework', 'Foundation',
        '-framework', 'CoreGraphics', '-o', path.join(output, 'window-picker')], { stdio: 'inherit' });
      execFileSync('xcrun', ['clang', '-fobjc-arc', '-O2',
        path.join(__dirname, 'native/macos/display-capture.m'), '-framework', 'Foundation',
        '-framework', 'ScreenCaptureKit', '-framework', 'ImageIO', '-framework', 'CoreGraphics',
        '-o', path.join(output, 'display-capture')], { stdio: 'inherit' });
    });
  } }],
  output: {
    ...baseConfig.output,
    filename: "[name].js",
    clean: true,
  },
};

const preloadConfig = {
  name: "preload",
  dependencies: ["main"],
  ...baseConfig,
  target: "electron-preload",
  entry: {
    "preload/index": "./src/preload/index.ts",
  },
  output: {
    ...baseConfig.output,
    filename: "[name].js",
    clean: false,
  },
};

const rendererConfig = {
  name: "renderer",
  dependencies: ["main"],
  ...baseConfig,
  target: "web",
  entry: {
    "renderer/window-picker/window-picker": "./src/renderer/window-picker/window-picker.ts",
    "renderer/capture/capture": "./src/renderer/capture/capture.ts",
    "renderer/overlay/overlay": "./src/renderer/overlay/overlay.ts",
    "renderer/picker/picker": "./src/renderer/picker/picker.ts",
    "renderer/control/control": "./src/renderer/control/control.ts",
    "renderer/transcript/transcript": "./src/renderer/transcript/transcript.ts",
  },
  output: {
    ...baseConfig.output,
    filename: "[name].js",
    clean: false,
  },
  plugins: [
    new CopyWebpackPlugin({
      patterns: [
        {
          from: "src/renderer/**/*.html",
          to({ absoluteFilename }) {
            return absoluteFilename.replace(
              path.resolve(__dirname, "src") + path.sep,
              "",
            );
          },
        },
        {
          from: "src/renderer/**/*.css",
          to({ absoluteFilename }) {
            return absoluteFilename.replace(
              path.resolve(__dirname, "src") + path.sep,
              "",
            );
          },
        },
      ],
    }),
  ],
};

module.exports = [mainConfig, preloadConfig, rendererConfig];

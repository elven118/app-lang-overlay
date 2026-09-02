const path = require("node:path");
const CopyWebpackPlugin = require("copy-webpack-plugin");

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
  entry: {
    main: "./src/main.ts",
  },
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
    "renderer/overlay/overlay": "./src/renderer/overlay/overlay.ts",
    "renderer/picker/picker": "./src/renderer/picker/picker.ts",
    "renderer/control/control": "./src/renderer/control/control.ts",
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

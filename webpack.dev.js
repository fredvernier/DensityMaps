  const path = require('path');

  module.exports = {
    mode: 'development',
    devtool: 'inline-source-map',
    entry: './client/client.js',
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'densityMaps.js',
      library: {
        name: "DensityMaps",
        type: "umd"
      },
    },
    externals: {
      fastpng: {
       commonjs: 'fast-png',
       commonjs2: 'fast-png',
       amd: 'fast-png'
     },
   },
  };

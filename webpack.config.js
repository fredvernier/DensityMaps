const webpack = require('webpack');
const path    = require('path');

module.exports = {
  mode: 'development',
  entry:{
    main: ['webpack-hot-middleware/client', "./client/client.js"]
  },// "./client/client.js",//path relative to this file
  plugins: [
    new webpack.HotModuleReplacementPlugin(),
    new webpack.ProvidePlugin({
      $: "jquery",
      jQuery: "jquery"
    })
  ],
  output: {
    library: {
      name: "DensityMaps",
      type: "umd"
    },
    //path: path.resolve(__dirname, 'public/js'),
    filename: 'js/client.js'
  }
}
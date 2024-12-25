const express = require('express');
const app      = express();
const port     = 8000;
const fs       = require("fs");    // filesystem to read&write files
const path     = require('path');
const fastpng  = require('fast-png');
//const sessions = require('express-session'); // to handle sessions (user remain connected over time)
//const ejs      = require('ejs');   // ejs is pur view engine
//const http     = require('http');
//const https    = require('https');

const webpack = require('webpack');
const middleware = require('webpack-dev-middleware'); //webpack hot reloading middleware
const webpackConfig = require('../webpack.config');
const compiler = webpack(webpackConfig);
const hmr = require("webpack-hot-middleware");

/*const compiler = webpack({
  mode: 'development',
  entry: "./client/client.js",//path relative to this file
  plugins: [
    new webpack.ProvidePlugin({
      $: "jquery",
      jQuery: "jquery"
    })
  ],
  output: { 
    filename: 'js/client.js'
  }
}); //move your `devServer` config from `webpack.config.js`
*/
app.use(hmr(compiler));

app.use(middleware(compiler, {
  // webpack-dev-middleware options
}));


app.get('/p', (req, res) => {
  let binary = fs.readFileSync(path.join(__dirname, '../data',req.query.dataname));
  //console.log(typeof binary)
  //console.log(req.query.dataname)

  let img=fastpng.decode(binary);
  //console.log(img)
  //console.log(img.width+"x"+img.height)
  let imgdata = img.data;
  let min0 = imgdata[0], max0 = imgdata[0], sum=0;
  for(let i in imgdata){
    min0 = Math.min(min0,imgdata[i]);
    max0 = Math.max(max0,imgdata[i]);
    sum += imgdata[i];
  }
  img.text = sum;
  //console.log("res= "+min0+" ... "+max0+" => "+sum)
  res.set('content-type', "image/png");
  let img2=fastpng.encode(img);
  
  res.send(Buffer.from(img2.buffer));
});


app.get('/datalist', (req, res) => {
  let ll =
  fs.readdirSync(path.join(__dirname, '../data'), {withFileTypes: true})
      .filter(item => !item.isDirectory()&&item.isFile()&&item.name.endsWith(".png"))
      .map(item => item.name);
  res.json(ll);
});


app.get('/', (req, res) => {
  //console.log("/")
  res.sendFile(path.join(__dirname, '../public', 'index.html'));
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});

app.use('/css',express.static(path.join(__dirname, '../public/css')));
app.use('/imgs',express.static(path.join(__dirname, '../public/imgs'))); 
//app.use('/js',express.static(__dirname+'/public/js'));

import _ from 'lodash';
import { decode } from "fast-png";
import  $  from "jquery";

console.log("client side")
const UPDATE_INTERVAL = 40; // Update every 200ms (5 times/sec)
let hBlurPipeline, vBlurPipeline;
let device = null;
let adapter = null;
let bindGroups = null;
let step = 0; // Track how many 
let GRID_SIZE_X, GRID_SIZE_Y;
let WORKGROUP_SIZE = 8;
let context;
let cellPipeline;
let vertexBuffer;
let vertices;
let cellStateArray;
let cellStateStorage;
let radius = 16;
let uniformAdjustBuffer, uniformBlurBuffer;
let img;
let pipelines = [];

function makeGaussKernel(sigma){
  if(sigma==0)
    return new Float32Array(1).fill(1,0,1);
  
  const GAUSSKERN = 6.0;
  var dim = parseInt(Math.max(3.0, GAUSSKERN * sigma));
  var sqrtSigmaPi2 = Math.sqrt(Math.PI*2.0)*sigma;
  var s2 = 2.0 * sigma * sigma;
  var sum = 0.0;
  
  var kernel = new Float32Array(dim - !(dim & 1)); // Make it odd number
  const half = parseInt(kernel.length / 2);
  for (var j = 0, i = -half; j < kernel.length; i++, j++)  {
    kernel[j] = Math.exp(-(i*i)/(s2)) / sqrtSigmaPi2;
    sum += kernel[j];
  }
  for (var i = 0; i < dim; i++) {
    kernel[i] /= sum;
  }
  return kernel;
}

export function init(){
  $.ajax({
    url: "/datalist",
    method: 'GET',
  }).done(function(data) {
    for(let d of data)
      $("#datamenu").append($('<button class="w3-bar-item w3-button w3-mobile" onclick="load(\''+d+'\')">'+d+'</button>'))
  }) .fail(function(err) {
    alert( "error" );
    console.log(err)
  });
}
window.init = init;

export function debug(){
  let kt = "** "
  for(let v of gk) 
    kt= kt+v+" ";
  console.log(kt);
}
window.debug = debug;

let gk = makeGaussKernel(radius);

export function load(dataname){
  $.ajax({
    url: "/p",
    data:{"dataname":dataname},
    contentType: "image/png",
    method: 'GET',
    xhrFields: { responseType: 'arraybuffer'}
  }).done(function(data) {
    img=decode(data);
    let $canvastag = $('<canvas id="canvastag" width="'+img.width+'" height="'+img.height+'"></canvas>')
    $("#contforvis").html($canvastag);
    createPipeline(img, $("#canvastag")[0]);
  }) .fail(function(err) {
    alert( "error" );
    console.log(err)
  });
}
window.load = load;

async function createPipeline(img, canvastag){
  if (!img) return
  //console.log("createPipeline NEW")
  GRID_SIZE_X = img.width;
  GRID_SIZE_Y = img.height;

  adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error("WebGPU not supported on this browser.");
  }

  device = await adapter.requestDevice();
  context = canvastag.getContext("webgpu");
  const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
  context.configure({
    device: device,
    format: canvasFormat,
    alphaMode: 'premultiplied',
  });

  // create data positions and send them to the queue
  vertices = new Float32Array([
  //   X,    Y,
    -1, -1, // Triangle 1 (Blue)
    1, -1,
    1,  1,

    -1, -1, // Triangle 2 (Red)
    1,  1,
    -1,  1,
  ]);
  vertexBuffer = device.createBuffer({
    label: "Cell vertices",
    size: vertices.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vertexBuffer, /*bufferOffset=*/0, vertices);
  const vertexBufferLayout = {
    arrayStride: 8,
    attributes: [{
      format: "float32x2",
      offset: 0,
      shaderLocation: 0, // Position, see vertex shader
    }],
  };

  // Create a uniform buffer that describes the grid.
  const uniformGridArray = new Float32Array([GRID_SIZE_X, GRID_SIZE_Y]);
  const uniformGridBuffer = device.createBuffer({
    label: "Grid Uniforms",
    size: uniformGridArray.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(uniformGridBuffer, 0, uniformGridArray);

  // Create a uniform buffer that describes the blur.
  const uniformBlurArray = new Float32Array(gk);
  uniformBlurBuffer = device.createBuffer({
    label: "Blur Uniforms",
    size: uniformBlurArray.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(uniformBlurBuffer, 0, uniformBlurArray);

  // Create a uniform buffer that describes the color adjustment.
  const uniformAdjustArray = new Float32Array([1000, 1400, 0.0001]);
  uniformAdjustBuffer = device.createBuffer({
    label: "Adjust Uniforms",
    size: uniformAdjustArray.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(uniformAdjustBuffer, 0, uniformAdjustArray);

  // Create an array representing the active state of each cell.
  cellStateArray = new Uint32Array(GRID_SIZE_X * GRID_SIZE_Y);
  // Create a storage buffer to hold the cell state.
  cellStateStorage = [
    device.createBuffer({
      label: "Cell State A",
      size: cellStateArray.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    }),
    device.createBuffer({
      label: "Cell State B",
      size: cellStateArray.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
  ];
  for (let i = 0; i < cellStateArray.length; ++i) {
    cellStateArray[i] = Math.round(img.data[i]);
  }

  device.queue.writeBuffer(cellStateStorage[0], 0, cellStateArray);
  device.queue.writeBuffer(cellStateStorage[1], 0, cellStateArray);

  // Mark every other cell of the second grid as active.
  /*for (let i = 0; i < cellStateArray.length; i++) {
    cellStateArray[i] = i % 2;
  }
  device.queue.writeBuffer(cellStateStorage[1], 0, cellStateArray);*/


  // create the shaders
  const cellShaderModule = device.createShaderModule({
    label: "Cell shader",
    code: `
      struct VertexInput {
        @location(0) pos: vec2f,
        @builtin(instance_index) instance: u32,
      };

      struct VertexOutput {
        @builtin(position) pos: vec4f,
        @location(0) cell: vec2f, 
        @location(1) @interpolate(flat) val: u32 
      };

      @group(0) @binding(0) var<uniform> grid: vec2f;
      @group(0) @binding(1) var<storage> cellState: array<u32>; 
      @group(0) @binding(4) var<uniform> globAdjust: vec2f;


      @vertex
      fn vertexMain(input: VertexInput) -> VertexOutput  {
        let i = f32(input.instance);
        let cell = vec2f(i % grid.x, grid.y-floor(i / grid.x));
        let state = f32(cellState[input.instance]); // New line!            

        let cellOffset = cell / grid * 2;
        let gridPos = (input.pos + 1) / grid - 1 + cellOffset;
        
        var output: VertexOutput;
        output.pos = vec4f(gridPos, 0, 1);
        output.cell = cell; 
        output.val = cellState[input.instance]; 
        return output;
      }
        
      struct FragInput {
        @location(0) cell: vec2f,
        @location(1) @interpolate(flat)  val: u32,
      };

      @fragment
      fn fragmentMain(input: FragInput) -> @location(0) vec4f {
        let bb1 = 1-max(input.cell.x/grid.x, input.cell.y/grid.y);
        let bb2 = sqrt(max(0,f32(input.val)-globAdjust[0]))/(globAdjust[1]-globAdjust[0]); 
        if (f32(input.val)<globAdjust[0]){
          return vec4f(0.0, 0.0, 0.0, 0.0);
        } else {
          return vec4f(bb2, bb2, bb2, 1);//input.cell/grid
        }
      }

    `
  });

  // Create the bind group layout and pipeline layout.
  const bindGroupLayout = device.createBindGroupLayout({
    label: "Cell Bind Group Layout",
    entries: [{
      binding: 0,
      visibility: GPUShaderStage.VERTEX | GPUShaderStage.COMPUTE | GPUShaderStage.FRAGMENT,
      buffer: {} // Grid uniform buffer
    }, {
      binding: 1,
      visibility: GPUShaderStage.VERTEX | GPUShaderStage.COMPUTE | GPUShaderStage.FRAGMENT,
      buffer: { type: "read-only-storage"} // Cell state input buffer
    }, {
      binding: 2,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "storage"} // Cell state output buffer
    },{
      binding: 3,
      visibility:  GPUShaderStage.COMPUTE ,
      buffer: {type: "read-only-storage"} // blur buffer
    },{
      binding: 4,
      visibility:  GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT ,
      buffer: {} // color adjustement uniform buffer
    }]
  });

  const pipelineLayout = device.createPipelineLayout({
    label: "Cell Pipeline Layout",
    bindGroupLayouts: [ bindGroupLayout ],
  });

  cellPipeline = device.createRenderPipeline({
    label: "Cell pipeline",
    layout: pipelineLayout,
    vertex: {
      module: cellShaderModule,
      entryPoint: "vertexMain",
      buffers: [vertexBufferLayout]
    },
    fragment: {
      module: cellShaderModule,
      entryPoint: "fragmentMain",
      targets: [{
        format: canvasFormat
      }]
    }
  });

  bindGroups = [
    device.createBindGroup({
      label: "Cell renderer bind group A",
      layout: bindGroupLayout,
      entries: [{
        binding: 0,
        resource: { buffer: uniformGridBuffer }
      }, {
        binding: 1,
        resource: { buffer: cellStateStorage[0] }
      }, {
        binding: 2, 
        resource: { buffer: cellStateStorage[1] }
      }, {
        binding: 3,
        resource: { buffer: uniformBlurBuffer }
      }, {
        binding: 4,
        resource: { buffer: uniformAdjustBuffer }
      }],
    }),
    device.createBindGroup({
      label: "Cell renderer bind group B",
      layout: bindGroupLayout,
      entries: [{
        binding: 0,
        resource: { buffer: uniformGridBuffer }
      }, {
        binding: 1,
        resource: { buffer: cellStateStorage[1] }
      }, {
        binding: 2, 
        resource: { buffer: cellStateStorage[0] }
      }, {
        binding: 3,
        resource: { buffer: uniformBlurBuffer }
      }, {
        binding: 4,
        resource: { buffer: uniformAdjustBuffer }
      }],
    })
  ];

  // Create the compute shader that will process the horizontal blur.
  const hBlurShaderModule = device.createShaderModule({
    label: "horizontal blur",
    code: `
      @group(0) @binding(0) var<uniform> grid: vec2f; // New line
      @group(0) @binding(1) var<storage> cellStateIn: array<u32>;
      @group(0) @binding(2) var<storage, read_write> cellStateOut: array<u32>;
      @group(0) @binding(3) var<storage> blur: array<f32>; // New line
      
      fn cellIndex(cell: vec2u) -> u32 {
        return (cell.y % u32(grid.y)) * u32(grid.x) +
              (cell.x % u32(grid.x));
      }

      fn cellActive(x: u32, y: u32) -> u32 {
        return cellStateIn[cellIndex(vec2(x, y))];
      }

      @compute @workgroup_size(${WORKGROUP_SIZE}, ${WORKGROUP_SIZE}) // New line
      fn computeMain(@builtin(global_invocation_id) cell: vec3u) {
        let r:u32 = u32((arrayLength(&blur)-1)/2);
        var sum:f32=0;
        var ws:f32=0;
        for(var i: i32=-i32(r); i<=i32(r); i++) {
          sum += blur[u32(i32(r)-i)]*f32(cellActive(u32(i32(cell.x)+i), cell.y+0));
          ws  += blur[u32(i32(r)-i)];
        }
        let sum2 =  1*cellActive(cell.x+1, cell.y+1) +
                    2*cellActive(cell.x+1, cell.y) +
                    1*cellActive(cell.x+1, cell.y-1) +
                    1*cellActive(cell.x-1, cell.y-1) +
                    2*cellActive(cell.x-1, cell.y) +
                    1*cellActive(cell.x-1, cell.y+1) +
                    2*cellActive(cell.x,   cell.y-1) +
                    4*cellActive(cell.x,   cell.y) +
                    2*cellActive(cell.x,   cell.y+1);
        let i = cellIndex(cell.xy);

        // Conway's game of life rules:
        /*switch sum {
          case 2: { // Active cells with 2 neighbors stay active.
            cellStateOut[i] = cellStateIn[i];
          }
          case 3: { // Cells with 3 neighbors become or stay active.
            cellStateOut[i] = 1;
          }
          default: { // Cells with < 2 or > 3 neighbors become inactive.
            cellStateOut[i] = 0;
          }
        }*/
        cellStateOut[i] = u32(sum/ws);
      }
      `
  });

  // Create the compute shader that will process the horizontal blur.
  const vBlurShaderModule = device.createShaderModule({
    label: "vertical blur",
    code: `
      @group(0) @binding(0) var<uniform> grid: vec2f; // New line
      @group(0) @binding(1) var<storage> cellStateIn: array<u32>;
      @group(0) @binding(2) var<storage, read_write> cellStateOut: array<u32>;
      @group(0) @binding(3) var<storage> blur: array<f32>; // New line
      
      fn cellIndex(cell: vec2u) -> u32 {
        return (cell.y % u32(grid.y)) * u32(grid.x) +
              (cell.x % u32(grid.x));
      }

      fn cellActive(x: u32, y: u32) -> u32 {
        return cellStateIn[cellIndex(vec2(x, y))];
      }

      @compute @workgroup_size(${WORKGROUP_SIZE}, ${WORKGROUP_SIZE}) // New line
      fn computeMain(@builtin(global_invocation_id) cell: vec3u) {
        let r:u32 = u32((arrayLength(&blur)-1)/2);
        var sum:f32=0;
        var ws:f32=0;
        for(var i: i32=-i32(r); i<=i32(r); i++) {
          sum += blur[u32(i32(r)-i)]*f32(cellActive(cell.x+0, u32(i32(cell.y)+i)));
          ws  += blur[u32(i32(r)-i)];
        }
        let sum2 =  1*cellActive(cell.x+1, cell.y+1) +
                    2*cellActive(cell.x+1, cell.y) +
                    1*cellActive(cell.x+1, cell.y-1) +
                    1*cellActive(cell.x-1, cell.y-1) +
                    2*cellActive(cell.x-1, cell.y) +
                    1*cellActive(cell.x-1, cell.y+1) +
                    2*cellActive(cell.x,   cell.y-1) +
                    4*cellActive(cell.x,   cell.y) +
                    2*cellActive(cell.x,   cell.y+1);
        let i = cellIndex(cell.xy);

        // Conway's game of life rules:
        /*switch sum {
          case 2: { // Active cells with 2 neighbors stay active.
            cellStateOut[i] = cellStateIn[i];
          }
          case 3: { // Cells with 3 neighbors become or stay active.
            cellStateOut[i] = 1;
          }
          default: { // Cells with < 2 or > 3 neighbors become inactive.
            cellStateOut[i] = 0;
          }
        }*/
        cellStateOut[i] = u32(sum/ws);
      }
      `
  });

  // Create a compute pipeline that updates the game state.
  hBlurPipeline = device.createComputePipeline({
    label: "hBlur pipeline",
    layout: pipelineLayout,
    compute: {
      module: hBlurShaderModule,
      entryPoint: "computeMain",
    }
  });

  // Create a compute pipeline that updates the game state.
  vBlurPipeline = device.createComputePipeline({
    label: "vBlur pipeline",
    layout: pipelineLayout,
    compute: {
      module: vBlurShaderModule,
      entryPoint: "computeMain",
    }
  });

  const encoder = device.createCommandEncoder();

  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: context.getCurrentTexture().createView(),
      loadOp: "clear",
      clearValue: { r: .2, g: 0.1, b: 0.4, a: 1 }, // New line
      storeOp: "store",
    }],
  });
  render();
}

export async function applyColorScale(){
  let colorscale = $('input[name="colorscale"]:checked').val();
  
}
window.applyColorScale = applyColorScale;

export async function applyBlur(){
  let blurtype = $('input[name="blurtype"]:checked').val();
  radius = parseInt($("#rblur").val());
  //console.log("applyHBlur "+radius)
  gk = makeGaussKernel(radius);

  await createPipeline(img, $("#canvastag")[0]);
  pipelines = [];
  if(blurtype=="h")
    pipelines = [hBlurPipeline];
  else  if(blurtype=="v")
    pipelines = [vBlurPipeline];
  else if(blurtype=="both")
    pipelines = [hBlurPipeline, vBlurPipeline];
  updateData();
}
window.applyBlur = applyBlur;

// Move all of our rendering code into a function
 function updateData() {
  if(!device) return;
  //console.log("  updateData "+  step )

  let t = performance.now();
  // Move the encoder creation to the top of the function.
  const encoder = device.createCommandEncoder();
  for (let pipeline of pipelines){
    const computePass = encoder.beginComputePass();

    computePass.setPipeline(pipeline);
    computePass.setBindGroup(0, bindGroups[step % 2]);

    const workgroupCountX = Math.ceil(GRID_SIZE_X / WORKGROUP_SIZE);
    const workgroupCountY = Math.ceil(GRID_SIZE_X / WORKGROUP_SIZE);
    computePass.dispatchWorkgroups(workgroupCountX, workgroupCountY);

    computePass.end();
    step++; // Increment the step count
  }
  device.queue.submit([encoder.finish()]);
  render();
  //console.log("updateData: "+(performance.now()-t));
}


export function render() {
  if(!device) return;
  let mi = parseInt($("#mi").val());
  let ma = parseInt($("#ma").val());
  //console.log("  render "+mi)

  const uniformAdjustArray = new Float32Array([mi, mi+ma, 0.0001]);
  device.queue.writeBuffer(uniformAdjustBuffer, 0, uniformAdjustArray);

  let t = performance.now();
  const encoder = device.createCommandEncoder();

  // Start a render pass 
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: context.getCurrentTexture().createView(),
      loadOp: "clear",
      clearValue: { r: 0, g: 0, b: 0.4, a: 1.0 },
      storeOp: "store",
    }]
  });

  // Draw the grid.
  pass.setPipeline(cellPipeline);
  pass.setBindGroup(0, bindGroups[step % 2]); // Updated!
  pass.setVertexBuffer(0, vertexBuffer);
  pass.draw(vertices.length / 2, GRID_SIZE_X * GRID_SIZE_Y);

  // End the render pass and submit the command buffer
  pass.end();
  device.queue.submit([encoder.finish()]);
  //console.log("render: "+(performance.now()-t));
}
window.render = render;

let updater= null;
export function start (){
  console.log("start")
  // Schedule updateData() to run repeatedly
  if (updater==null)
    updater = setInterval(updateData, UPDATE_INTERVAL);
}
window.start = start;


export function stop (){
  console.log("stop")
  clearInterval(updater);
  updater=null;
  render();
}
window.stop = stop;


export function reset (){
  for (let i = 0; i < cellStateArray.length; ++i) 
    cellStateArray[i] = Math.round(img.data[i]);
  device.queue.writeBuffer(cellStateStorage[0], 0, cellStateArray);
  device.queue.writeBuffer(cellStateStorage[1], 0, cellStateArray);
  render();
}
window.reset = reset;

/* pass.setPipeline(cellPipeline);
pass.setVertexBuffer(0, vertexBuffer);
pass.setBindGroup(0, bindGroup); // 2 floats = grid size
pass.draw(vertices.length / 2,  GRID_SIZE * GRID_SIZE); // 6 vertices .. many times
pass.end();
device.queue.submit([encoder.finish()]);*/

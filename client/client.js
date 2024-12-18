//import _ from 'lodash';
//import  $  from "jquery";
import { decode } from "fast-png";

export function load(dataSource, containerid='contforvis', zoom=1, tagid=null){
   return DensityMaps.load(dataSource, containerid, zoom, tagid);
}

export class DensityMaps {
  #hBlurPipeline;
  #vBlurPipeline;
  #device = null;
  #adapter = null;
  #bindGroups = null;
  #step = 0; // Track how many 
  #GRID_SIZE_X;
  #GRID_SIZE_Y;
  #WORKGROUP_SIZE = 8;
  #context;
  #cellPipeline;
  #vertexBuffer;
  #vertices;
  #cellStateArray;
  #cellStateStorage;

  #uniformAdjustBuffer;
  #uniformBlurBuffer;
  #img;
  #pipelines = [];
  #gk;
  canvas;

  params = {
    mi : 0,
    ma : 8,
    radius : 4, 
    blurtype : '', 
    colorscale : ''
  };

  constructor() {
    this.#gk = DensityMaps.makeGaussKernel(this.params.radius);
  }

  static makeGaussKernel(sigma){
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
    for (i = 0; i < dim; i++) {
      kernel[i] /= sum;
    }
    return kernel;
  }


  async debug(){
    let gk = DensityMaps.makeGaussKernel(DensityMaps.params.radius);
    let kt = "** ";
    for(let v of gk) 
      kt= kt+v+" ";
    console.log(kt);
    let dm = await load({
      width:8,
      height:8,
      data: new Uint16Array([
        0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 8,10, 8, 0, 0,
        0, 0, 8,13,14,13, 8, 0,
        0, 0,10,14,16,14,10, 0,
        0, 0, 8,13,14,13, 8, 0,
        0, 0, 0, 8,10, 8, 0, 0,
        0, 0, 0, 8,10, 8, 0, 0
      ])
    }, "contid", 4);
    dm.render();
    this.params.mi=1;
    this.params.ma=8;
  }


  static async load(dataSource, containerid='contforvis', zoom=1, tagid=null){
   // console.log("load ")
    //console.log(containerid)
    //console.log(dataSource.width+"*"+zoom)
    let container = document.getElementById(containerid);
    let newobj =new DensityMaps();
    if(typeof dataSource=="string"){
      //try {
        const response = await fetch("/p?dataname="+dataSource, {
          method: "GET",
          headers: {
          /* Accept: 'image/png',*/
            'Content-Type': "application/octet-stream"
          },
          responseType: "arraybuffer"
        });
        if (!response.ok) 
          throw new Error(`Response status: ${response.status}`);

        const data = await response.arrayBuffer();
        newobj.#img=decode(data);
        dataSource = newobj.#img;
    } else if(typeof dataSource=="object"){
      if (dataSource.data.length != dataSource.width * dataSource.height)
        throw new Error(
          `Inconsistent data source length ${dataSource.data.length} != ${dataSource.width * dataSource.height}`
        );
      newobj.#img = dataSource;
    }

    let id = tagid==null ? "" : `id="${tagid}"`;
    container.innerHTML = '<canvas '+id+' width="'+(dataSource.width*zoom)+'" height="'+(dataSource.height*zoom)+'"></canvas>';
    newobj.canvas=container.firstChild;
    newobj.#adapter = await navigator.gpu.requestAdapter();
    if (!newobj.#adapter) {
      throw new Error("WebGPU not supported on this browser.");
    }

    newobj.#device = await newobj.#adapter.requestDevice();
    newobj.init();
    return newobj;
  }


  init() {
    //console.log("init ")
    // var globCanvasrect = this.canvas.getBoundingClientRect();
    // this.canvas.addEventListener("mousemove", function(e){
    //   console.log((e.clientX-globCanvasrect.left)+","+(e.clientY-globCanvasrect.top));
    // });

    if (!this.#img) return;
    this.#GRID_SIZE_X = this.#img.width;
    this.#GRID_SIZE_Y = this.#img.height;
    
    this.#context = this.canvas.getContext("webgpu");
    const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    this.#context.configure({
      device: this.#device,
      format: canvasFormat,
      alphaMode: 'premultiplied',
    });

    // create data positions and send them to the queue
    this.#vertices = new Float32Array([
    //   X,    Y,
      -1, -1, // Triangle 1 (Blue)
      1, -1,
      1,  1,

      -1, -1, // Triangle 2 (Red)
      1,  1,
      -1,  1,
    ]);
    this.#vertexBuffer = this.#device.createBuffer({
      label: "Cell vertices",
      size: this.#vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    this.#device.queue.writeBuffer(this.#vertexBuffer, /*bufferOffset=*/0, this.#vertices);
    const vertexBufferLayout = {
      arrayStride: 8,
      attributes: [{
        format: "float32x2",
        offset: 0,
        shaderLocation: 0, // Position, see vertex shader
      }],
    };

    // Create a uniform buffer that describes the grid.
    const uniformGridArray = new Float32Array([this.#GRID_SIZE_X, this.#GRID_SIZE_Y]);
    const uniformGridBuffer = this.#device.createBuffer({
      label: "Grid Uniforms",
      size: uniformGridArray.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#device.queue.writeBuffer(uniformGridBuffer, 0, uniformGridArray);

    // Create a uniform buffer that describes the blur.
    const uniformBlurArray = new Float32Array(this.#gk);
    this.#uniformBlurBuffer = this.#device.createBuffer({
      label: "Blur Uniforms",
      size: uniformBlurArray.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.#device.queue.writeBuffer(this.#uniformBlurBuffer, 0, uniformBlurArray);

    // Create a uniform buffer that describes the color adjustment.
    const uniformAdjustArray = new Float32Array([1000, 1400, 0.0001]);
    this.#uniformAdjustBuffer = this.#device.createBuffer({
      label: "Adjust Uniforms",
      size: uniformAdjustArray.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#device.queue.writeBuffer(this.#uniformAdjustBuffer, 0, uniformAdjustArray);

    // Create an array representing the active state of each cell.
    this.#cellStateArray = Uint32Array.from(this.#img.data); // copy and truncate
    // Create a storage buffer to hold the cell state.
    this.#cellStateStorage = [
      this.#device.createBuffer({
        label: "Cell State A",
        size: this.#cellStateArray.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      }),
      this.#device.createBuffer({
        label: "Cell State B",
        size: this.#cellStateArray.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      })
    ];
    this.#device.queue.writeBuffer(this.#cellStateStorage[0], 0, this.#cellStateArray);
    this.#device.queue.writeBuffer(this.#cellStateStorage[1], 0, this.#cellStateArray);


    // create the shaders
    const cellShaderModule = this.#device.createShaderModule({
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
          let gridPos = (input.pos - vec2(-1,1)) / grid - 1 + cellOffset;
          
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
          let bb2 = sqrt(max(0.0,f32(input.val)-globAdjust[0]))/(globAdjust[1]-globAdjust[0]); 
          if (f32(input.val)<globAdjust[0]){
            return vec4f(0.0, 0.0, 0.0, 0.0);
          } else {
            return vec4f(bb2, bb2, bb2, 1.0);//input.cell/grid
          }
        }

      `
    });

    // Create the bind group layout and pipeline layout.
    const bindGroupLayout = this.#device.createBindGroupLayout({
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

    const pipelineLayout = this.#device.createPipelineLayout({
      label: "Cell Pipeline Layout",
      bindGroupLayouts: [ bindGroupLayout ],
    });

    this.#cellPipeline = this.#device.createRenderPipeline({
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

    this.#bindGroups = [
      this.#device.createBindGroup({
        label: "Cell renderer bind group A",
        layout: bindGroupLayout,
        entries: [{
          binding: 0,
          resource: { buffer: uniformGridBuffer }
        }, {
          binding: 1,
          resource: { buffer: this.#cellStateStorage[0] }
        }, {
          binding: 2, 
          resource: { buffer: this.#cellStateStorage[1] }
        }, {
          binding: 3,
          resource: { buffer: this.#uniformBlurBuffer }
        }, {
          binding: 4,
          resource: { buffer: this.#uniformAdjustBuffer }
        }],
      }),
      this.#device.createBindGroup({
        label: "Cell renderer bind group B",
        layout: bindGroupLayout,
        entries: [{
          binding: 0,
          resource: { buffer: uniformGridBuffer }
        }, {
          binding: 1,
          resource: { buffer: this.#cellStateStorage[1] }
        }, {
          binding: 2, 
          resource: { buffer: this.#cellStateStorage[0] }
        }, {
          binding: 3,
          resource: { buffer: this.#uniformBlurBuffer }
        }, {
          binding: 4,
          resource: { buffer: this.#uniformAdjustBuffer }
        }],
      })
    ];

    // Create the compute shader that will process the horizontal blur.
    const hBlurShaderModule = this.#device.createShaderModule({
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

        @compute @workgroup_size(${this.#WORKGROUP_SIZE}, ${this.#WORKGROUP_SIZE}) // New line
        fn computeMain(@builtin(global_invocation_id) cell: vec3u) {
          let r:u32 = u32((arrayLength(&blur)-1)/2);
          var sum:f32=0;
          var ws:f32=0;
          for(var i: i32=-i32(r); i<=i32(r); i++) {
            sum += blur[u32(i32(r)-i)]*f32(cellActive(u32(i32(cell.x)+i), cell.y+0));
            ws  += blur[u32(i32(r)-i)];
          }

          let i = cellIndex(cell.xy);
          cellStateOut[i] = u32(sum/ws);
        }
        `
    });

    // Create the compute shader that will process the horizontal blur.
    const vBlurShaderModule = this.#device.createShaderModule({
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

        @compute @workgroup_size(${this.#WORKGROUP_SIZE}, ${this.#WORKGROUP_SIZE}) // New line
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
    this.#hBlurPipeline = this.#device.createComputePipeline({
      label: "hBlur pipeline",
      layout: pipelineLayout,
      compute: {
        module: hBlurShaderModule,
        entryPoint: "computeMain",
      }
    });

    // Create a compute pipeline that updates the game state.
    this.#vBlurPipeline = this.#device.createComputePipeline({
      label: "vBlur pipeline",
      layout: pipelineLayout,
      compute: {
        module: vBlurShaderModule,
        entryPoint: "computeMain",
      }
    });

    const encoder = this.#device.createCommandEncoder();

    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.#context.getCurrentTexture().createView(),
        loadOp: "clear",
        clearValue: { r: 0.2, g: 0.1, b: 0.4, a: 1 }, // New line
        storeOp: "store",
      }],
    });
    pass; //TODO: remove! avoids an eslint warning for now
    //this.render();
  }

  async  applyColorScale(){
    
  }

  async applyBlur(){
    this.#gk = DensityMaps.makeGaussKernel(this.params.radius);

    this.init();
    this.#pipelines = [];
    if(this.params.blurtype=="h")
      this.#pipelines = [this.#hBlurPipeline];
    else  if(this.params.blurtype=="v")
      this.#pipelines = [this.#vBlurPipeline];
    else if(this.params.blurtype=="both")
      this.#pipelines = [this.#hBlurPipeline, this.#vBlurPipeline];
    this.updateData();
  }

// Move all of our rendering code into a function
  updateData() {
    if(!this.#device) return;
    //console.log("  updateData "+  this.#step )

    //let t = performance.now();
    // Move the encoder creation to the top of the function.
    const encoder = this.#device.createCommandEncoder();
    for (let pipeline of this.#pipelines){
      const computePass = encoder.beginComputePass();

      computePass.setPipeline(pipeline);
      computePass.setBindGroup(0, this.#bindGroups[this.#step % 2]);

      const workgroupCountX = Math.ceil(this.#GRID_SIZE_X / this.#WORKGROUP_SIZE);
      const workgroupCountY = Math.ceil(this.#GRID_SIZE_X / this.#WORKGROUP_SIZE);
      computePass.dispatchWorkgroups(workgroupCountX, workgroupCountY);

      computePass.end();
      this.#step++; // Increment the step count
    }
    this.#device.queue.submit([encoder.finish()]);
    this.render();
    //console.log("updateData: "+(performance.now()-t));
  }


  render() {
    if(!this.#device) return;

    const uniformAdjustArray = new Float32Array([this.params.mi, this.params.mi+this.params.ma, 0.0001]);
    this.#device.queue.writeBuffer(this.#uniformAdjustBuffer, 0, uniformAdjustArray);

    //let t = performance.now();
    const encoder = this.#device.createCommandEncoder();

    // Start a render pass 
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.#context.getCurrentTexture().createView(),
        loadOp: "clear",
        clearValue: { r: 0, g: 0, b: 0.4, a: 1.0 },
        storeOp: "store",
      }]
    });

    // Draw the grid.
    pass.setPipeline(this.#cellPipeline);
    pass.setBindGroup(0, this.#bindGroups[this.#step % 2]); // Updated!
    pass.setVertexBuffer(0, this.#vertexBuffer);
    pass.draw(this.#vertices.length / 2, this.#GRID_SIZE_X * this.#GRID_SIZE_Y);

    // End the render pass and submit the command buffer
    pass.end();
    this.#device.queue.submit([encoder.finish()]);
    //console.log("render: "+(performance.now()-t));
  }



  reset (){
    this.#cellStateArray = Uint32Array.from(this.#img.data); // copy and truncate
    this.#device.queue.writeBuffer(this.#cellStateStorage[0], 0, this.#cellStateArray);
    this.#device.queue.writeBuffer(this.#cellStateStorage[1], 0, this.#cellStateArray);
    this.render();
  }
}

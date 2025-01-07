/* jshint esversion: 6 */
import { decode } from "fast-png";

export async function load(dataSource, containerid = 'contforvis', zoom = 1, tagid = null) {
  return DensityMaps.load(dataSource, containerid, zoom, tagid);
}

export async function debug() {
  return DensityMaps.debug();
}

export default class DensityMaps {
  #hBlurPipeline;
  #vBlurPipeline;
  #bilatBlurPipeline;

  #texurl = "";
  #device = null;
  #adapter = null;
  #bindGroupsRender = null;
  #bindGroupsData = null;
  #bindGroupLayoutData = null;
  #bindGroupLayoutRender = null;
  #uniformGridBuffer = null;
  #step = 0; // Track how many 
  #GRID_SIZE_X;
  #GRID_SIZE_Y;
  #WORKGROUP_SIZE = 8;
  #context;
  #renderPipeline;
  #vertexBuffer;
  #vertices;
  #cellStateArray;
  #cellStateStorage;
  #texture;
  #sampler;
  #legend;

  #uniformAdjustBuffer;
  #uniformBlurBuffer;
  #uniformParamBuffer;

  #img;
  #pipelines = [];
  #gk;
  canvas;
  canvas2;

  params = {
    mi: 0,
    ma: 16,
    min: 0,
    max: 16,
    radius: 4,
    bilat: 10000,
    blurtype: '',
    colorscale: '',
    displayLegend:false,
    legendTickCount: 6
  };

  constructor() {
    this.#gk = DensityMaps.makeGaussKernel(this.params.radius);
  }

  static async loadImageBitmap(url) {
    var img;
    if (url == '') {
      //console.log("Creating a grey texture");
      const size = 256;
      const data = new Uint8ClampedArray(4*size);
      for (let i = 0; i < size*4; i += 4) {
        data[i + 0] = i;
        data[i + 1] = i;
        data[i + 2] = i;
        data[i + 3] = 255;
      }
      img = new ImageData(data, size);
    }
    else {
      const res = await fetch(url);
      img = await res.blob();
    }
    return await createImageBitmap(img, { colorSpaceConversion: 'none' });
  }

  async updateColorRamp(url) {
    this.#texurl = url;
    let source = await DensityMaps.loadImageBitmap(url);
    this.#legend = source;
    const texture = this.#device.createTexture({
      label: url,
      format: 'rgba8unorm',
      size: [source.width, source.height],
      usage: GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.#device.queue.copyExternalImageToTexture(
      { source, flipY: true },
      { texture },
      { width: source.width, height: source.height },
    );
    this.#sampler = this.#device.createSampler({
      minFilter: 'linear',
    });

    this.#texture = texture;
    this.updateRenderBindGroup();
    this.render();
  }

  static makeGaussKernel(sigma) {
    if (sigma == 0)
      return new Float32Array(1).fill(1, 0, 1);

    const GAUSSKERN = 6.0;
    var dim = parseInt(Math.max(3.0, GAUSSKERN * sigma));
    var sqrtSigmaPi2 = Math.sqrt(Math.PI * 2.0) * sigma;
    var s2 = 2.0 * sigma * sigma;
    var sum = 0.0;

    var kernel = new Float32Array(dim - !(dim & 1)); // Make it odd number
    const half = parseInt(kernel.length / 2);
    for (var j = 0, i = -half; j < kernel.length; i++, j++) {
      kernel[j] = Math.exp(-(i * i) / (s2)) / sqrtSigmaPi2;
      sum += kernel[j];
    }
    for (i = 0; i < dim; i++) {
      kernel[i] /= sum;
    }
    return kernel;
  }


  static async debug() {
    let gk = DensityMaps.makeGaussKernel(8);
    let kt = "** ";
    for (let v of gk)
      kt = kt + v + " ";
    console.log(kt);
    let dm = await load({
      width: 8,
      height: 8,
      data: new Uint16Array([
        0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 8, 10, 8, 0, 0,
        0, 0, 8, 13, 14, 13, 8, 0,
        0, 0, 10, 14, 16, 14, 10, 0,
        0, 0, 8, 13, 14, 13, 8, 0,
        0, 0, 0, 8, 10, 8, 0, 0,
        0, 0, 0, 8, 10, 8, 0, 0
      ])
    }, "contid", 4);
    dm.render();
    dm.params.mi = 1;
    dm.params.ma = 8;
  }


  static async load(dataSource, containerid = 'contforvis', zoom = 1, tagid = null) {
    //console.log("load "+containerid+" => "+zoom)
    //console.log(containerid)
    //console.log(dataSource.width+"*"+zoom)
    let container = containerid;
    if (typeof container == "string")
      container = document.getElementById(containerid);
    let newobj = new DensityMaps();
    if (typeof dataSource == "string" && dataSource.startsWith("server://")) {
      //try {
      const response = await fetch("/p?dataname=" + dataSource.substring(9), {
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
      newobj.#img = decode(data);
      dataSource = newobj.#img;
    } else if (typeof dataSource == "string") {
      //try {
      const response = await fetch(dataSource, {
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
      newobj.#img = decode(data);
      dataSource = newobj.#img;
    } else if (typeof dataSource == "object") {
      if (dataSource.data.length != dataSource.width * dataSource.height)
        throw new Error(
          `Inconsistent data source length ${dataSource.data.length} != ${dataSource.width * dataSource.height}`
        );
      newobj.#img = dataSource;
    }

    let id = tagid == null ? "" : `id="${tagid}"`;
    let id2 = tagid == null ? "" : `id="${tagid}_2"`;
    container.innerHTML = `<div style="position:relative;width:${Math.trunc(dataSource.width * zoom)}px;height:${Math.trunc(dataSource.height * zoom)}px;"><canvas  style="position:absolute;top:0;left:0" ${id} \
width="${Math.trunc(dataSource.width * zoom)}" \
height="${Math.trunc(dataSource.height * zoom)}"></canvas><canvas style="position:absolute;top:0;left:0" ${id2} \
width="${Math.trunc(dataSource.width * zoom)}" \
height="${Math.trunc(dataSource.height * zoom)}"></canvas></div>`;
    newobj.canvas = container.firstChild.firstChild;
    newobj.canvas2 = container.firstChild.childNodes[1];
    newobj.#adapter = await navigator.gpu.requestAdapter();
    if (!newobj.#adapter) {
      throw new Error("WebGPU not supported on this browser.");
    }

    newobj.#device = await newobj.#adapter.requestDevice();
    await newobj.init();
    return newobj;
  }

  setDataSource(dataSource) {
    if (typeof dataSource != "object")
      throw new Error(`Invalid data source ${dataSource}`);

    if (dataSource.data.length != dataSource.width * dataSource.height)
      throw new Error(
        `Inconsistent data source length \
${dataSource.data.length} != ${dataSource.width * dataSource.height}`
      );
    if (dataSource.data.length != this.#img.data.length)
      throw new Error(
        `Invalid data source size \
(${dataSource.data.width}, ${dataSource.data.height}) != \
(${this.#img.data.width},${this.#img.data.height})`
      );

    this.#img = dataSource;

    this.reset();
    this.render();
  }

  async init() {
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
      1, 1,

      -1, -1, // Triangle 2 (Red)
      1, 1,
      -1, 1,
    ]);
    this.#vertexBuffer = this.#device.createBuffer({
      label: "Cell vertices",
      size: this.#vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    await this.updateColorRamp("imgs/GREY.png");

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
    this.#uniformGridBuffer = this.#device.createBuffer({
      label: "Grid Uniforms",
      size: uniformGridArray.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#device.queue.writeBuffer(this.#uniformGridBuffer, 0, uniformGridArray);

    // Create a uniform buffer that describes the blur kernel.
    const uniformBlurArray = new Float32Array(this.#gk);
    this.#uniformBlurBuffer = this.#device.createBuffer({
      label: "Blur Uniforms",
      size: uniformBlurArray.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.#device.queue.writeBuffer(this.#uniformBlurBuffer, 0, uniformBlurArray);

    // Create a uniform buffer that describes the parameter of data processing.
    const uniformParamArray = new Float32Array([this.params.radius, this.params.bilat]);
    this.#uniformParamBuffer = this.#device.createBuffer({
      label: "Param Uniforms",
      size: uniformParamArray.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#device.queue.writeBuffer(this.#uniformParamBuffer, 0, uniformParamArray);

    // Create a uniform buffer that describes the color adjustment.
    const uniformAdjustArray = new Float32Array([1000, 1400, 0.0001]);
    this.#uniformAdjustBuffer = this.#device.createBuffer({
      label: "Adjust Uniforms",
      size: uniformAdjustArray.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#device.queue.writeBuffer(this.#uniformAdjustBuffer, 0, uniformAdjustArray);

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
        @group(0) @binding(2) var<uniform> globAdjust: vec2f;
        @group(0) @binding(3) var ourTexture: texture_2d<f32>;  // 
        @group(0) @binding(4) var ourSampler: sampler;

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
          let bb2 = (max(0.0,f32(input.val)-globAdjust[0]))/(globAdjust[1]-globAdjust[0]); 
          if (f32(input.val)<globAdjust[0]){
            return vec4f(0.0, 0.0, 0.0, 0.0);
            //return textureSampleLevel(ourTexture, ourSampler, vec2f(0.1, 0.1),0.0 );
          } else {
            //return vec4f(bb2, bb2, bb2, 1.0);//input.cell/grid
            return textureSampleLevel(ourTexture, ourSampler, vec2f(bb2, 0.5), 0.0);
          }
        }

      `
    });

    // Create the bind group layout and pipeline layout.
    this.#bindGroupLayoutData = this.#device.createBindGroupLayout({
      label: "Data Bind Group Layout",
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {} // Grid uniform buffer
      }, {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "read-only-storage" } // data input buffer
      }, {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "storage" } // data output buffer
      }, {
        binding: 3,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "read-only-storage" } // data processing kernel
      }, {
        binding: 4,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {} //// data processing parameters
      }]
    });

    this.#bindGroupLayoutRender = this.#device.createBindGroupLayout({
      label: "Cell Bind Group Layout",
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: {} // Grid uniform buffer
      }, {
        binding: 1,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "read-only-storage" } // Cell state input buffer
      }, {
        binding: 2,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: {} // color adjustement uniform buffer
      }, {
        binding: 3,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        texture: {}
      }, {
        binding: 4,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        sampler: {}
      }]
    });

    const renderPipelineLayout = this.#device.createPipelineLayout({
      label: "render Pipeline Layout",
      bindGroupLayouts: [this.#bindGroupLayoutRender],
    });

    this.#renderPipeline = this.#device.createRenderPipeline({
      label: "render pipeline",
      layout: renderPipelineLayout,
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


    const dataPipelineLayout = this.#device.createPipelineLayout({
      label: "data Pipeline Layout",
      bindGroupLayouts: [this.#bindGroupLayoutData],
    });
    this.reset();

    this.updateDataBindGroup();
    this.updateRenderBindGroup();

    // Create the compute shader that will process the horizontal blur.
    const hBlurShaderModule = this.#device.createShaderModule({
      label: "horizontal blur",
      code: `
        @group(0) @binding(0) var<uniform> grid: vec2f; // New line
        @group(0) @binding(1) var<storage> dataIn: array<u32>;
        @group(0) @binding(2) var<storage, read_write> dataOut: array<u32>;
        @group(0) @binding(3) var<storage> blur: array<f32>; // New line
        
        fn cellIndex(cell: vec2u) -> u32 {
          return (cell.y % u32(grid.y)) * u32(grid.x) +
                (cell.x % u32(grid.x));
        }

        fn cellActive(x: u32, y: u32) -> u32 {
          return dataIn[cellIndex(vec2(x, y))];
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
          dataOut[i] = u32(sum/ws);
        }
        `
    });

    // Create the compute shader that will process the vertical blur.
    const vBlurShaderModule = this.#device.createShaderModule({
      label: "vertical blur",
      code: `
        @group(0) @binding(0) var<uniform> grid: vec2f; // New line
        @group(0) @binding(1) var<storage> dataIn: array<u32>;
        @group(0) @binding(2) var<storage, read_write> dataOut: array<u32>;
        @group(0) @binding(3) var<storage> blur: array<f32>; // New line
        
        fn cellIndex(cell: vec2u) -> u32 {
          return (cell.y % u32(grid.y)) * u32(grid.x) +
                (cell.x % u32(grid.x));
        }

        fn cellActive(x: u32, y: u32) -> u32 {
          return dataIn[cellIndex(vec2(x, y))];
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

          let i = cellIndex(cell.xy);
          dataOut[i] = u32(sum/ws);
        }
        `
    });
    // Create the compute shader that will process the vertical blur.
    const bilatShaderModule = this.#device.createShaderModule({
      label: "vertical blur",
      code: `
        @group(0) @binding(0) var<uniform> grid: vec2f; 
        @group(0) @binding(1) var<storage> dataIn: array<u32>;
        @group(0) @binding(2) var<storage, read_write> dataOut: array<u32>;
        @group(0) @binding(3) var<storage> blur: array<f32>; 
        @group(0) @binding(4) var<uniform> bilat: vec2f; 
        
        fn cellIndex(cell: vec2u) -> u32 {
          return (cell.y % u32(grid.y)) * u32(grid.x) +
                (cell.x % u32(grid.x));
        }

        fn cellActive(x: u32, y: u32) -> u32 {
          return dataIn[cellIndex(vec2(x, y))];
        }

        @compute @workgroup_size(${this.#WORKGROUP_SIZE}, ${this.#WORKGROUP_SIZE}) // New line
        fn computeMain(@builtin(global_invocation_id) cell: vec3u) {
          let r:u32 = u32((arrayLength(&blur)-1)/2);
          var sum:f32=0;
          var ws:f32=0;
          var d:f32= 0;
          var refval:u32 =cellActive(u32(i32(cell.x)), u32(i32(cell.y)));
          for(var j: i32=-i32(r); j<=i32(r); j++) {
            for(var i: i32=-i32(r); i<=i32(r); i++) {
              d = sqrt(f32(i*i+j*j));
              var val:u32 = cellActive(u32(i32(cell.x)+i), u32(i32(cell.y)+j));
              var dval:f32 = f32(abs(refval-val));
              var w =blur[u32(f32(r)-d)]* exp(-(dval*dval)/(bilat.y*bilat.y)); 
              sum += w*f32(val);
              ws  += w;
            }
          }

          let i = cellIndex(cell.xy);
          dataOut[i] = u32(sum/ws);
        }
        `
    });

    // Create a compute pipeline that updates the values.
    this.#hBlurPipeline = this.#device.createComputePipeline({
      label: "hBlur pipeline",
      layout: dataPipelineLayout,
      compute: {
        module: hBlurShaderModule,
        entryPoint: "computeMain",
      }
    });

    // Create a compute pipeline that updates the values.
    this.#vBlurPipeline = this.#device.createComputePipeline({
      label: "vBlur pipeline",
      layout: dataPipelineLayout,
      compute: {
        module: vBlurShaderModule,
        entryPoint: "computeMain",
      }
    });

    // Create a compute pipeline that updates the values.
    this.#bilatBlurPipeline = this.#device.createComputePipeline({
      label: "bilateral Blur pipeline",
      layout: dataPipelineLayout,
      compute: {
        module: bilatShaderModule,
        entryPoint: "computeMain",
      }
    });



    this.render();
  }

  updateRenderBindGroup() {
    if (!this.#uniformGridBuffer) return;

    this.#bindGroupsRender = [
      this.#device.createBindGroup({
        label: "renderer bind group A " + this.#texurl,
        layout: this.#bindGroupLayoutRender,
        entries: [{
          binding: 0,
          resource: { buffer: this.#uniformGridBuffer }
        }, {
          binding: 1,
          resource: { buffer: this.#cellStateStorage[0] }
        }, {
          binding: 2,
          resource: { buffer: this.#uniformAdjustBuffer }
        }, {
          binding: 3,
          resource: this.#texture.createView(),
        }, {
          binding: 4,
          resource: this.#sampler
        }],
      }),
      this.#device.createBindGroup({
        label: "renderer bind group B " + this.#texurl,
        layout: this.#bindGroupLayoutRender,
        entries: [{
          binding: 0,
          resource: { buffer: this.#uniformGridBuffer }
        }, {
          binding: 1,
          resource: { buffer: this.#cellStateStorage[1] }
        }, {
          binding: 2,
          resource: { buffer: this.#uniformAdjustBuffer }
        }, {
          binding: 3,
          resource: this.#texture.createView(),
        }, {
          binding: 4,
          resource: this.#sampler
        }],
      })
    ];
  }

  updateDataBindGroup() {
    if (!this.#uniformGridBuffer) return;

    this.#bindGroupsData = [
      this.#device.createBindGroup({
        label: "data processing bind group A ",
        layout: this.#bindGroupLayoutData,
        entries: [{
          binding: 0,
          resource: { buffer: this.#uniformGridBuffer }
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
          resource: { buffer: this.#uniformParamBuffer }
        }],
      }),
      this.#device.createBindGroup({
        label: "data processing bind group B ",
        layout: this.#bindGroupLayoutData,
        entries: [{
          binding: 0,
          resource: { buffer: this.#uniformGridBuffer }
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
          resource: { buffer: this.#uniformParamBuffer }
        }],
      })
    ];
  }

  async updateDataFilter() {
    console.log("updateDataFilter "+this.params.bilat);
    this.#gk = DensityMaps.makeGaussKernel(this.params.radius);

    this.reset();
    const uniformBlurArray = new Float32Array(this.#gk);
    this.#uniformBlurBuffer = this.#device.createBuffer({
      label: "Blur Uniforms",
      size: uniformBlurArray.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.#device.queue.writeBuffer(this.#uniformBlurBuffer, 0, uniformBlurArray);

    const uniformParamArray = new Float32Array([this.params.radius, this.params.bilat]);
    this.#uniformParamBuffer = this.#device.createBuffer({
      label: "Param Uniforms",
      size: uniformParamArray.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#device.queue.writeBuffer(this.#uniformParamBuffer, 0, uniformParamArray);

    this.updateDataBindGroup();

    this.#pipelines = [];
    if (this.params.blurtype == "h")
      this.#pipelines = [this.#hBlurPipeline];
    else if (this.params.blurtype == "v")
      this.#pipelines = [this.#vBlurPipeline];
    else if (this.params.blurtype == "b")
      this.#pipelines = [this.#bilatBlurPipeline];
    else if (this.params.blurtype == "both")
      this.#pipelines = [this.#hBlurPipeline, this.#vBlurPipeline];
    this.updateData();
  }

  // Move all of our rendering code into a function
  updateData() {
    if (!this.#device) return;
    //let t = performance.now();
    // Move the encoder creation to the top of the function.
    const encoder = this.#device.createCommandEncoder();
    for (let pipeline of this.#pipelines) {
      const computePass = encoder.beginComputePass();

      computePass.setPipeline(pipeline);
      computePass.setBindGroup(0, this.#bindGroupsData[this.#step % 2]);

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
    if (!this.#device || !this.#device.queue || !this.#uniformAdjustBuffer) return;

    const uniformAdjustArray = new Float32Array([this.params.mi, this.params.ma, 0.0001]);
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
    pass.setPipeline(this.#renderPipeline);
    pass.setBindGroup(0, this.#bindGroupsRender[this.#step % 2]); // Updated!
    pass.setVertexBuffer(0, this.#vertexBuffer);
    pass.draw(this.#vertices.length / 2, this.#GRID_SIZE_X * this.#GRID_SIZE_Y);

    // End the render pass and submit the command buffer
    pass.end();
    this.#device.queue.submit([encoder.finish()]);

    let ctx = this.canvas2.getContext("2d");
    if(this.params.displayLegend===true){
      ctx.fillStyle = "white";
      ctx.fillRect(8, 8, this.#legend.width, 48);
      ctx.drawImage(this.#legend, 8, 8, this.#legend.width, 24);

      ctx.beginPath(); 
      ctx.strokeStyle = "black";
      for(let i=0; i<this.#legend.width; i+=(this.#legend.width-1)/this.params.legendTickCount){
        ctx.moveTo(8+i, 32); 
        ctx.lineTo(8+i, 36); 
      }
      ctx.fillStyle = "black";
      ctx.font = "12px sans serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for(let i=0; i<this.#legend.width; i+=(this.#legend.width-1)/this.params.legendTickCount){
        ctx.fillText(Math.round(this.params.mi+i*(this.params.ma-this.params.mi)/this.params.legendTickCount), 8+i, 32+4); 
      }
      ctx.stroke();
      //ctx.line(0,0,this.canvas2.width, this.canvas2.height);
      ctx.stroke();
      //console.log("render: "+(performance.now()-t));
    }
  }

  reset() {
    //console.log("reset")
    //console.log(this.#img)
    if (!this.#img.channels || this.#img.channels===1)
      this.#cellStateArray = Uint32Array.from(this.#img.data); // copy and truncate
    else if (this.#img.channels===4 && this.#img.depth===8){
      let tr = new Uint32Array(this.#img.data.length/4);
      for(let i=0; i<tr.length; i++){
        if (!(this.#img.data[i*4+2]&0x80))
          tr[i] = (this.#img.data[i*4+0]<<8) | this.#img.data[i*4+1];
        else
          tr[i] = 0;//-64-(this.#img.data[i*4+2]<<8|this.#img.data[i*4+1]);
       // tr[i] = this.#img.data[i*4+0]*256*256*256+this.#img.data[i*4+1]*256*256+this.#img.data[i*4+2]*256+this.#img.data[i*4+3];
      }
      this.#cellStateArray = Uint32Array.from(tr);
    } else if (this.#img.channels===3 && this.#img.depth===8){
      let tr = new Uint8Array(this.#img.data.length/3);
      for(let i=0; i<tr.length; i++)
        tr[i] = this.#img.data[i*3];
      
      this.#cellStateArray = Uint32Array.from(tr);
    }
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
    this.updateDataBindGroup();
    this.updateRenderBindGroup();

    let mi = this.#cellStateArray[0];
    let ma = this.#cellStateArray[0];
    //let nbz = 0;
    for (let i=0; i<this.#cellStateArray.length; i++){
      mi = Math.min(mi, this.#cellStateArray[i]);
      ma = Math.max(ma, this.#cellStateArray[i]);
      //if(this.#cellStateArray[i]===0) nbz++;
    }
    this.params.min = mi;
    this.params.max = ma;
    this.params.mi = Math.round(mi+(ma-mi)/64);
    this.params.ma = Math.round(ma-(ma-mi)/64);
    //console.log(mi+" ... "+ma+"  nbz="+nbz+"/"+this.#img.data.length)
    this.#device.queue.writeBuffer(this.#cellStateStorage[0], 0, this.#cellStateArray);
    this.#device.queue.writeBuffer(this.#cellStateStorage[1], 0, this.#cellStateArray);
    
  }
}

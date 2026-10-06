// 播放用的 GPU 繪製器（WebGL2）。
// 背景執行緒以完整演算法處理小圖，再把「原圖 → 結果」擬合成逐通道的局部仿射色彩轉換 out = a·in + b
// （a、b 是平滑的係數圖）；這裡每一格影片都在 GPU 上套用最新的係數，播放就能跟原片一樣順。
// 係數更新得比影片慢沒關係：色彩轉換本來就隨時間緩慢變化（還有時間平滑）。

const VS = `#version 300 es
in vec2 p;
out vec2 uv;
void main() {
  uv = vec2((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5); // 紋理第 0 列 = 畫面頂端
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
uniform sampler2D src, coefA, coefB;
uniform float split, amount, pre; // pre：方法自己的強度（深度模型的「強度」），amount：與原片混合
uniform int mode; // 0 分割、1 結果、2 原始
uniform bool useMat; // 全域 3×4 色彩矩陣（Diverout_sim）取代局部係數
uniform vec4 m0, m1, m2;
in vec2 uv;
out vec4 o;
void main() {
  vec3 s = texture(src, uv).rgb;
  vec4 s1 = vec4(s, 1.0);
  vec3 r = useMat ? clamp(vec3(dot(m0, s1), dot(m1, s1), dot(m2, s1)), 0.0, 1.0)
                  : clamp(s + (texture(coefA, uv).rgb * s + texture(coefB, uv).rgb - s) * pre, 0.0, 1.0);
  r = mix(s, r, amount);
  bool showResult = mode == 1 || (mode == 0 && uv.x >= split);
  o = vec4(showResult ? r : s, 1.0);
}`;

export class GLPlayer {
  /** 不支援 WebGL2 時丟出錯誤（呼叫端改用逐幀處理的舊路徑）。 */
  constructor(canvas, { preserve = false } = {}) {
    // preserve：匯出時畫完要讀回（交給編碼器），保留繪圖緩衝區
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, antialias: false, preserveDrawingBuffer: preserve });
    if (!gl) throw new Error('WebGL2 不可用');
    this.gl = gl;
    this.canvas = canvas;
    const prog = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, FS]]) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      gl.attachShader(prog, sh);
    }
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    this.prog = prog;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.tex = [0, 1, 2].map((unit) => {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    });
    gl.uniform1i(gl.getUniformLocation(prog, 'src'), 0);
    gl.uniform1i(gl.getUniformLocation(prog, 'coefA'), 1);
    gl.uniform1i(gl.getUniformLocation(prog, 'coefB'), 2);
    this.uSplit = gl.getUniformLocation(prog, 'split');
    this.uMode = gl.getUniformLocation(prog, 'mode');
    this.uAmount = gl.getUniformLocation(prog, 'amount');
    this.uPre = gl.getUniformLocation(prog, 'pre');
    this.uUseMat = gl.getUniformLocation(prog, 'useMat');
    this.uM = ['m0', 'm1', 'm2'].map((k) => gl.getUniformLocation(prog, k));
    this.resetCoeffs();
  }

  /** 恆等轉換（a = 1、b = 0）：還沒有係數前畫面就是原片 */
  resetCoeffs() {
    this.setCoeffs(new Float32Array([1, 1, 1, 1]), new Float32Array([0, 0, 0, 0]), 1, 1);
    this.hasCoeffs = false;
  }

  /** a、b：RGBA float32（cw × ch，第 0 列在上） */
  setCoeffs(a, b, cw, ch) {
    const gl = this.gl;
    for (const [unit, data] of [[1, a], [2, b]]) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, this.tex[unit]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, cw, ch, 0, gl.RGBA, gl.FLOAT, data);
    }
    this.hasCoeffs = true;
  }

  /** rows：3 列 [r, g, b, 常數]（[0,1] 色值）；null = 改回局部係數 */
  setMatrix(rows) {
    const gl = this.gl;
    gl.uniform1i(this.uUseMat, rows ? 1 : 0);
    if (rows) rows.forEach((r, i) => gl.uniform4f(this.uM[i], r[0], r[1], r[2], r[3]));
  }

  /** 深度模型的係數（net.js estimate 的 g：nw×nh 的 a、b 三個平面）→ 係數貼圖 */
  setNetCoeffs(g) {
    const n = g.nw * g.nh, A = new Float32Array(4 * n), B = new Float32Array(4 * n);
    for (let c = 0; c < 3; c++) {
      const a = g.a[c], b = g.b[c];
      for (let i = 0; i < n; i++) { A[4 * i + c] = a[i]; B[4 * i + c] = b[i]; }
    }
    this.setCoeffs(A, B, g.nw, g.nh);
  }

  /** source：<video> 或 <canvas>；opts：{ split, mode: 'split'|'result'|'original', amount, pre } */
  draw(source, opts) {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[0]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.uniform1f(this.uSplit, opts.split);
    gl.uniform1i(this.uMode, opts.mode === 'result' ? 1 : opts.mode === 'original' ? 2 : 0);
    gl.uniform1f(this.uAmount, opts.amount ?? 1);
    gl.uniform1f(this.uPre, opts.pre ?? 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

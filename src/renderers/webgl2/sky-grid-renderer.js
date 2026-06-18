import { linkProgram, getUniformLocations } from './shader-utils.js';
import { SKY_VERT, SKY_FRAG, GRID_VERT, GRID_FRAG } from './shaders.js';

export class SkyGridRenderer {
  constructor(gl) {
    this.gl = gl;
    this.skyProgram = linkProgram(gl, SKY_VERT, SKY_FRAG);
    this.gridProgram = linkProgram(gl, GRID_VERT, GRID_FRAG);
    this.skyLocs = getUniformLocations(gl, this.skyProgram, ['u_time']);
    this.gridLocs = getUniformLocations(gl, this.gridProgram, ['u_viewProj', 'u_cameraPos']);

    this._buildGrid();
  }

  _buildGrid() {
    const gl = this.gl;
    const size = 80;
    const step = 2;
    const verts = [];
    for (let x = -size; x <= size; x += step) {
      verts.push(x, -0.01, -size, x, -0.01, size);
    }
    for (let z = -size; z <= size; z += step) {
      verts.push(-size, -0.01, z, size, -0.01, z);
    }
    this.gridCount = verts.length / 3;
    this.gridVao = gl.createVertexArray();
    gl.bindVertexArray(this.gridVao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);
    gl.bindVertexArray(null);
  }

  drawSky(time) {
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.skyProgram);
    gl.uniform1f(this.skyLocs.u_time, time);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.DEPTH_TEST);
  }

  drawGrid(viewProj, cameraPos) {
    const gl = this.gl;
    gl.useProgram(this.gridProgram);
    gl.uniformMatrix4fv(this.gridLocs.u_viewProj, false, viewProj);
    gl.uniform3fv(this.gridLocs.u_cameraPos, cameraPos);
    gl.bindVertexArray(this.gridVao);
    gl.drawArrays(gl.LINES, 0, this.gridCount);
    gl.bindVertexArray(null);
  }
}

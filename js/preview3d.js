/**
 * Three.js preview of the generated terrain solid. The mesh arrives z-up in
 * millimeters; we rotate it into three.js's y-up world.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { LAND_GRADIENT, SEA_GRADIENT, gradientColor } from './colors.js';
export { LAND_GRADIENT, SEA_GRADIENT, gradientColor };

export class TerrainPreview {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x14181f);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;

    this.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a2e22, 1.0));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(1, 2, 1.2);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.35);
    fill.position.set(-1.5, 0.8, -1);
    this.scene.add(fill);

    this.group = new THREE.Group();
    this.group.rotation.x = -Math.PI / 2; // model z-up -> three y-up
    this.scene.add(this.group);
    this.mesh = null;
    this.wireframe = false;

    this._animate = this._animate.bind(this);
    requestAnimationFrame(this._animate);
  }

  _animate() {
    requestAnimationFrame(this._animate);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w && h && (this.canvas.width !== Math.round(w * this.renderer.getPixelRatio()) ||
                   this.canvas.height !== Math.round(h * this.renderer.getPixelRatio()))) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * @param {?number} seaZ model-space z of the waterline; vertices below it
   *   get bathymetric blues instead of the land gradient. null = all land.
   */
  setMesh(positions, indices, seaZ = null) {
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
      this.mesh = null;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeVertexNormals();

    // Vertex colors by height.
    let minZ = Infinity, maxZ = -Infinity;
    for (let v = 2; v < positions.length; v += 3) {
      if (positions[v] < minZ) minZ = positions[v];
      if (positions[v] > maxZ) maxZ = positions[v];
    }
    const colors = new Float32Array(positions.length);
    const hasSea = seaZ !== null && seaZ > minZ;
    const landBase = hasSea ? Math.min(seaZ, maxZ) : minZ;
    const landSpan = maxZ - landBase || 1;
    const seaSpan = hasSea ? seaZ - minZ || 1 : 1;
    for (let v = 0; v < positions.length; v += 3) {
      const z = positions[v + 2];
      const rgb = hasSea && z < seaZ
        ? gradientColor(SEA_GRADIENT, (z - minZ) / seaSpan)
        : gradientColor(LAND_GRADIENT, (z - landBase) / landSpan);
      colors[v] = rgb[0]; colors[v + 1] = rgb[1]; colors[v + 2] = rgb[2];
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.85,
      metalness: 0.02,
      wireframe: this.wireframe,
    });
    this.mesh = new THREE.Mesh(geo, mat);

    // Center the model on the origin.
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const cx = (bb.min.x + bb.max.x) / 2;
    const cy = (bb.min.y + bb.max.y) / 2;
    this.mesh.position.set(-cx, -cy, 0);
    this.group.add(this.mesh);

    // Frame the camera.
    const sizeX = bb.max.x - bb.min.x;
    const sizeY = bb.max.y - bb.min.y;
    const sizeZ = bb.max.z - bb.min.z;
    const radius = Math.max(sizeX, sizeY, sizeZ);
    this.camera.position.set(radius * 0.9, radius * 0.85, radius * 1.1);
    this.camera.near = radius / 100;
    this.camera.far = radius * 20;
    this.camera.updateProjectionMatrix();
    this.controls.target.set(0, sizeZ / 2, 0);
    this.controls.update();
  }

  setWireframe(on) {
    this.wireframe = on;
    if (this.mesh) this.mesh.material.wireframe = on;
  }
}

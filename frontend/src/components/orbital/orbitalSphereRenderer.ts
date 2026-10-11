/* Orbital Sphere renderer
   来源：ThreeUI（github.com/MengTo/threeui，MIT License）
   原文件：lib-dist/shaders/orbital-sphere/orbitalSphereRenderer.js（编译基准 three@0.128.0）
   本副本为 NIS 移植版：① import 改为 'three'；② 大件变量可读化（逻辑与视觉参数保持原样，颜色注释保留原十进制值）。
   视觉：紫色粒子云球体（15000 点，双色渐变）+ 6 条轨道环 + 奇数环上的发光节点/光晕。 */
import * as THREE from 'three'

type OrbitalSphereOptions = {
  speed: number
  particleSize: number
  particleOpacity: number
  orbitOpacity: number
  scale: number
  haloOpacity: number
  hue: number
}

export const ORBITAL_SPHERE_DEFAULTS: OrbitalSphereOptions = {
  speed: 1,
  particleSize: 0.015,
  particleOpacity: 0.8,
  orbitOpacity: 0.25,
  scale: 1,
  haloOpacity: 0.2,
  hue: 0
}

export function createOrbitalSphereRenderer(
  canvas: HTMLCanvasElement,
  getOptions: () => OrbitalSphereOptions
): {
  resize(width: number, height: number): void
  render(): void
  dispose(): void
} {
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1e3)
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

  const group = new THREE.Group()
  scene.add(group)

  /* ── 粒子云球体：Fibonacci 球面分布，位移调制 + 一侧裁剪，双色渐变 ── */
  const f = 2.2
  const M = 15e3
  const positions = new Float32Array(M * 3)
  const colors = new Float32Array(M * 3)
  const I = new THREE.Color(10980346) // #A78BFA 亮紫
  const O = new THREE.Color(7346805) // #701A75 深紫
  let n = 0
  for (let e = 0; e < M; e += 1) {
    const o = Math.acos(-1 + (2 * e) / M)
    const r = Math.sqrt(M * Math.PI) * o
    const c = f * Math.cos(r) * Math.sin(o)
    const l = f * Math.sin(r) * Math.sin(o)
    const s = f * Math.cos(o)
    const i = Math.sin(c * 3.5) * Math.cos(l * 3.5) * Math.sin(s * 3.5) + Math.cos(c * 6) * 0.4
    if (i <= -0.1) continue
    const p = 1 + i * 0.1
    positions[n * 3] = c * p
    positions[n * 3 + 1] = l * p
    positions[n * 3 + 2] = s * p
    const d = O.clone().lerp(I, i > 0.5 ? 1 : 0.3)
    colors[n * 3] = d.r
    colors[n * 3 + 1] = d.g
    colors[n * 3 + 2] = d.b
    n += 1
  }
  const particleGeo = new THREE.BufferGeometry()
  particleGeo.setAttribute('position', new THREE.BufferAttribute(positions.slice(0, n * 3), 3))
  particleGeo.setAttribute('color', new THREE.BufferAttribute(colors.slice(0, n * 3), 3))
  const particleMat = new THREE.PointsMaterial({
    size: ORBITAL_SPHERE_DEFAULTS.particleSize,
    vertexColors: true,
    transparent: true,
    opacity: 0.8,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  })
  group.add(new THREE.Points(particleGeo, particleMat))

  /* ── 6 条轨道环（奇数环挂发光节点 + 光晕） ── */
  const orbitMat = new THREE.LineBasicMaterial({
    color: 9133302, // #8B5CF6
    transparent: true,
    opacity: 0.25,
    blending: THREE.AdditiveBlending
  })
  const orbitGeos: THREE.BufferGeometry[] = []
  const nodeGeos: THREE.SphereGeometry[] = []
  const nodeMats: THREE.Material[] = []
  const halos: THREE.MeshBasicMaterial[] = []
  let layoutScale = 1
  /* 轨道环的**取向**过去用 Math.random() —— 每次实例化都不同。
     0919 起改成固定种子：开屏链路有两处会各自建一个球
     （boot 页那份裸 HTML 里的，与 Vue 里这份），取向一致才不会
     "换页时环突然转了另一个角度"。同时重启后样子也稳定。 */
  let seed = 20260919
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }
  for (let e = 0; e < 6; e += 1) {
    const o = new THREE.BufferGeometry()
    const r: number[] = []
    const c = f * (1.08 + rnd() * 0.2)
    for (let s = 0; s <= 90; s += 1) {
      const i = (s / 90) * Math.PI * 2
      r.push(Math.cos(i) * c, Math.sin(i) * c, Math.sin(i * 4) * 0.1)
    }
    o.setAttribute('position', new THREE.Float32BufferAttribute(r, 3))
    orbitGeos.push(o)
    const line = new THREE.Line(o, orbitMat)
    line.rotation.x = rnd() * Math.PI * 2
    line.rotation.y = rnd() * Math.PI * 2
    group.add(line)
    if (e % 2 !== 0) {
      const nodeGeo = new THREE.SphereGeometry(0.025, 16, 16)
      const nodeMat = new THREE.MeshBasicMaterial({ color: 14239471 }) // #D946EF
      const node = new THREE.Mesh(nodeGeo, nodeMat)
      const d = rnd() * Math.PI * 2
      node.position.set(Math.cos(d) * c, Math.sin(d) * c, 0)
      line.add(node)
      const haloGeo = new THREE.SphereGeometry(0.08, 16, 16)
      const haloMat = new THREE.MeshBasicMaterial({
        color: 12616956, // #C084FC
        transparent: true,
        opacity: 0.2,
        blending: THREE.AdditiveBlending
      })
      node.add(new THREE.Mesh(haloGeo, haloMat))
      nodeGeos.push(nodeGeo, haloGeo)
      nodeMats.push(nodeMat, haloMat)
      halos.push(haloMat)
    }
  }

  return {
    resize(width: number, height: number) {
      camera.aspect = width / Math.max(1, height)
      camera.updateProjectionMatrix()
      renderer.setSize(width, height, false)
      const opts = getOptions()
      if (width >= 1024) {
        group.position.set(2.5, 0, -2)
        layoutScale = 1.15
        camera.position.z = 5.5
      } else {
        group.position.set(0, -1, -3)
        layoutScale = 1
        camera.position.z = 6.5
      }
      group.scale.setScalar(layoutScale * opts.scale)
    },
    render() {
      const opts = getOptions()
      particleMat.size = opts.particleSize
      particleMat.opacity = opts.particleOpacity
      orbitMat.opacity = opts.orbitOpacity
      halos.forEach((h) => (h.opacity = opts.haloOpacity))
      group.scale.setScalar(layoutScale * opts.scale)
      group.rotation.y += 8e-4 * opts.speed
      group.rotation.x += 3e-4 * opts.speed
      group.children.forEach((o, r) => {
        if (o.type === 'Line') o.rotation.z += 4e-4 * opts.speed * (r % 2 === 0 ? 1 : -1)
      })
      renderer.render(scene, camera)
    },
    dispose() {
      particleGeo.dispose()
      particleMat.dispose()
      orbitMat.dispose()
      orbitGeos.forEach((g) => g.dispose())
      nodeGeos.forEach((g) => g.dispose())
      nodeMats.forEach((m) => m.dispose())
      renderer.dispose()
    }
  }
}

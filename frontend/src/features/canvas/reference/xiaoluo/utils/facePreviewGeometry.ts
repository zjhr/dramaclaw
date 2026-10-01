import * as THREE from 'three';

/** 头部特写取景：使用头部包围盒，留出表情和轻微倾斜所需的空间。 */
export function frameFaceCamera(camera: THREE.PerspectiveCamera, headSize: THREE.Vector3): void {
  const halfFov = THREE.MathUtils.degToRad(camera.fov) / 2;
  // 男女预览现有最大缩放为 1.16 / 1.06，取景时计入，避免切换后裁掉额头。
  const halfHeight = headSize.y * 1.06 / 2;
  const halfWidth = headSize.x * 1.16 / 2;
  // 更贴近脸部：去掉 8% 额外余量，仅保留性别缩放所需空间。
  const distance = Math.max(halfHeight / Math.tan(halfFov), halfWidth / (Math.tan(halfFov) * camera.aspect)) * 1.0 + headSize.z * 1.04 / 2;
  camera.position.set(0, 0, distance);
  camera.near = Math.max(0.001, distance / 100);
  camera.far = Math.max(10, distance * 10);
  // 视线略微下移到五官高度，让眼鼻嘴居中、颈部残端沉到画面底缘外。
  camera.lookAt(0, headSize.y * 0.06, 0);
  camera.updateProjectionMatrix();
}

/** 一个新顶点对应原始顶点的线性权重；所有表情使用同一组权重。 */
type Stencil = Array<readonly [number, number]>;
type Edge = { a: number; b: number; opposite: number[]; output: number };

/**
 * 对灰模做一次 Loop 细分，同时细分所有 Blendshape。
 * 仅处理无骨骼、单材质的索引网格；不改变原几何，保留形态名称及相对位移语义。
 */
export function refineFaceGeometry(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const position = source.getAttribute('position');
  const index = source.getIndex();
  if (!position || !index || source.getAttribute('skinIndex') || source.groups.length > 1) return source.clone();
  const targets = source.morphAttributes.position ?? [];
  const representatives: number[] = [];
  const canonical = new Uint32Array(position.count);
  const buckets = new Map<string, number[]>();
  // 灰模不使用 UV 贴图；合并 UV 接缝的重复顶点时，还要保证所有形态位移一致。
  for (let i = 0; i < position.count; i++) {
    const key = [position.getX(i), position.getY(i), position.getZ(i)].map(v => Math.round(v * 1e6)).join(',');
    const candidates = buckets.get(key) ?? [];
    const match = candidates.find(candidate => targets.every(target => {
      const representative = representatives[candidate];
      return Math.abs(target.getX(i) - target.getX(representative)) < 1e-7 && Math.abs(target.getY(i) - target.getY(representative)) < 1e-7 && Math.abs(target.getZ(i) - target.getZ(representative)) < 1e-7;
    }));
    if (match !== undefined) canonical[i] = match;
    else {
      canonical[i] = representatives.length;
      candidates.push(representatives.length);
      representatives.push(i);
      buckets.set(key, candidates);
    }
  }
  const neighbors = representatives.map(() => new Set<number>());
  const boundaries = representatives.map(() => new Set<number>());
  const edges = new Map<string, Edge>();
  const edgeKey = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`;
  const triangles: number[][] = [];
  for (let i = 0; i < index.count; i += 3) {
    const triangle = [0, 1, 2].map(offset => canonical[index.getX(i + offset)]);
    const [a, b, c] = triangle;
    if (a === b || b === c || a === c) continue;
    triangles.push(triangle);
    for (const [u, v, opposite] of [[a, b, c], [b, c, a], [c, a, b]]) {
      neighbors[u].add(v); neighbors[v].add(u);
      const key = edgeKey(u, v);
      const edge = edges.get(key) ?? { a: u, b: v, opposite: [], output: 0 };
      edge.opposite.push(opposite);
      edges.set(key, edge);
    }
  }
  edges.forEach(({ a, b, opposite }) => {
    if (opposite.length !== 2) { boundaries[a].add(b); boundaries[b].add(a); }
  });
  const stencils: Stencil[] = representatives.map((_, vertex) => {
    const boundary = [...boundaries[vertex]];
    if (boundary.length === 2) return [[vertex, 0.75], [boundary[0], 0.125], [boundary[1], 0.125]];
    if (boundary.length > 0 || neighbors[vertex].size < 3) return [[vertex, 1]];
    const ring = [...neighbors[vertex]];
    const beta = (5 / 8 - (3 / 8 + Math.cos(2 * Math.PI / ring.length) / 4) ** 2) / ring.length;
    return [[vertex, 1 - ring.length * beta], ...ring.map(n => [n, beta] as const)];
  });
  edges.forEach(edge => {
    edge.output = stencils.length;
    stencils.push(edge.opposite.length === 2
      ? [[edge.a, 0.375], [edge.b, 0.375], [edge.opposite[0], 0.125], [edge.opposite[1], 0.125]]
      : [[edge.a, 0.5], [edge.b, 0.5]]);
  });
  const outputIndex: number[] = [];
  triangles.forEach(([a, b, c]) => {
    const ab = edges.get(edgeKey(a, b))!.output;
    const bc = edges.get(edgeKey(b, c))!.output;
    const ca = edges.get(edgeKey(c, a))!.output;
    outputIndex.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
  });
  const apply = (attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute) => {
    const values = new Float32Array(stencils.length * 3);
    stencils.forEach((stencil, output) => stencil.forEach(([vertex, weight]) => {
      const input = representatives[vertex];
      values[output * 3] += attribute.getX(input) * weight;
      values[output * 3 + 1] += attribute.getY(input) * weight;
      values[output * 3 + 2] += attribute.getZ(input) * weight;
    }));
    const result = new THREE.BufferAttribute(values, 3);
    result.name = attribute.name;
    return result;
  };
  const refined = new THREE.BufferGeometry();
  refined.name = source.name;
  refined.setIndex(outputIndex);
  refined.setAttribute('position', apply(position));
  refined.computeVertexNormals();
  refined.morphTargetsRelative = source.morphTargetsRelative;
  refined.morphAttributes.position = targets.map(apply);
  const base = refined.getAttribute('position');
  const baseNormal = refined.getAttribute('normal');
  // 每个形态的法线从细分后的实际顶点重建，避免变形后仍使用中性脸的阴影。
  refined.morphAttributes.normal = refined.morphAttributes.position.map(target => {
    const absolute = new Float32Array(base.count * 3);
    for (let i = 0; i < absolute.length; i++) absolute[i] = target.array[i] + (source.morphTargetsRelative ? base.array[i] : 0);
    const shape = new THREE.BufferGeometry();
    shape.setIndex(refined.getIndex()!.clone());
    shape.setAttribute('position', new THREE.BufferAttribute(absolute, 3));
    shape.computeVertexNormals();
    const normal = shape.getAttribute('normal').clone() as THREE.BufferAttribute;
    normal.name = target.name;
    if (source.morphTargetsRelative) for (let i = 0; i < normal.array.length; i++) normal.array[i] -= baseNormal.array[i];
    shape.dispose();
    return normal;
  });
  refined.computeBoundingBox();
  refined.computeBoundingSphere();
  return refined;
}

import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { FacialState } from '../types';
import type { MannequinGender } from './MannequinHeadViewport';
import { frameFaceCamera, refineFaceGeometry } from '../utils/facePreviewGeometry';

interface ThreeMannequinViewportProps {
  facialState: FacialState;
  gender: MannequinGender;
  emotionName?: string;
  showMesh?: boolean;
}

type MorphTargetMap = Record<string, number>;
type MorphMesh = THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]> & {
  morphTargetDictionary: Record<string, number>;
  morphTargetInfluences: number[];
};
type ProceduralFace = {
  head: THREE.Mesh;
  leftBrow: THREE.Mesh;
  rightBrow: THREE.Mesh;
  jaw: THREE.Group;
  mouth: THREE.Mesh;
};

const clamp = (value: number, min = 0, max = 1) =>
  Math.min(max, Math.max(min, value));

const setMorph = (targets: MorphTargetMap, name: string, value: number) => {
  targets[name] = Math.max(targets[name] ?? 0, clamp(value));
};

// 高精度头模（含贴图头发），按性别切换；失败时回退灰模 facecap。
const HD_MODEL_FEMALE_URL = '/xiaoluo/models/face-hd.glb';
const HD_MODEL_MALE_URL = '/xiaoluo/models/face-hd-male.glb';
// 两套头模的 morph 都是 ARKit camelCase Left/Right，驱动器用 facecap 的 _L/_R；查表时把 camelCase 还原成下划线名。
const toUnderscoreMorph = (name: string) => name.replace(/Left$/, '_L').replace(/Right$/, '_R');
// 真人头模是站姿全身 glb，预览只保留头部相关网格，隐藏躯干/服装/鞋以突出脸部。
const HD_HIDDEN_MESH = /Body|Outfit|Footwear|Foot|Shoe|Hand|Bottom|Top|Pants|Shirt|Cloth|Look|Suit/i;

/** Convert the editor's semantic controls to the model's ARKit-style blendshapes. */
const buildMorphTargets = (facialState: FacialState): MorphTargetMap => {
  const { eye, eyebrow, mouth, face } = facialState;
  const targets: MorphTargetMap = {};

  const openness = clamp(eye.openness / 50, -1, 1);
  const eyeAsymmetry = clamp((eye.asymmetry ?? 0) / 100, -1, 1);
  const baseBlink = openness < 0 ? -openness * 0.92 : 0;
  const baseWide = openness > 0 ? openness * 0.86 : 0;
  const focus = clamp(eye.focus / 100);
  const focusSquint = clamp((focus - 0.48) / 0.52) * 0.34;

  setMorph(targets, 'eyeBlink_L', baseBlink + Math.max(0, eyeAsymmetry) * 0.82);
  setMorph(targets, 'eyeBlink_R', baseBlink + Math.max(0, -eyeAsymmetry) * 0.82);
  setMorph(targets, 'eyeWide_L', baseWide + Math.max(0, -eyeAsymmetry) * 0.28);
  setMorph(targets, 'eyeWide_R', baseWide + Math.max(0, eyeAsymmetry) * 0.28);
  setMorph(targets, 'eyeSquint_L', focusSquint);
  setMorph(targets, 'eyeSquint_R', focusSquint);

  switch (eye.direction) {
    case 'down':
      setMorph(targets, 'eyeLookDown_L', 0.72);
      setMorph(targets, 'eyeLookDown_R', 0.72);
      break;
    case 'up':
      setMorph(targets, 'eyeLookUp_L', 0.7);
      setMorph(targets, 'eyeLookUp_R', 0.7);
      break;
    case 'side':
      setMorph(targets, 'eyeLookOut_L', 0.7);
      setMorph(targets, 'eyeLookIn_R', 0.7);
      break;
    case 'avoid gaze':
      setMorph(targets, 'eyeLookIn_L', 0.46);
      setMorph(targets, 'eyeLookOut_R', 0.46);
      setMorph(targets, 'eyeBlink_L', baseBlink + 0.1);
      setMorph(targets, 'eyeBlink_R', baseBlink + 0.1);
      break;
    case 'cold stare':
      setMorph(targets, 'eyeSquint_L', focusSquint + 0.28);
      setMorph(targets, 'eyeSquint_R', focusSquint + 0.28);
      break;
    case 'soft gaze':
      setMorph(targets, 'eyeBlink_L', baseBlink + 0.12);
      setMorph(targets, 'eyeBlink_R', baseBlink + 0.12);
      setMorph(targets, 'eyeSquint_L', focusSquint + 0.08);
      setMorph(targets, 'eyeSquint_R', focusSquint + 0.08);
      break;
    default:
      break;
  }

  const browTension = clamp(eyebrow.tension / 100);
  const browHeight = clamp(eyebrow.height / 50, -1, 1);
  const innerLift = clamp((eyebrow.innerLift ?? 0) / 100, -1, 1);
  setMorph(targets, 'browDown_L', browTension * 0.82 + Math.max(0, -browHeight) * 0.28);
  setMorph(targets, 'browDown_R', browTension * 0.82 + Math.max(0, -browHeight) * 0.28);
  setMorph(targets, 'browOuterUp_L', Math.max(0, browHeight) * 0.72);
  setMorph(targets, 'browOuterUp_R', Math.max(0, browHeight) * 0.72);
  setMorph(targets, 'browInnerUp', Math.max(0, innerLift) * 0.95 + Math.max(0, browHeight) * 0.24);

  const curve = clamp(mouth.curve / 100, -1, 1);
  const tension = clamp(mouth.tension / 100);
  const mouthAsymmetry = clamp((mouth.asymmetry ?? 0) / 100, -1, 1);
  const smile = Math.max(0, curve);
  const frown = Math.max(0, -curve);
  const leftBias = mouthAsymmetry * 0.48;
  setMorph(targets, 'mouthSmile_L', smile * 0.94 + Math.max(0, leftBias));
  setMorph(targets, 'mouthSmile_R', smile * 0.94 + Math.max(0, -leftBias));
  setMorph(targets, 'mouthFrown_L', frown * 0.92 + Math.max(0, -leftBias));
  setMorph(targets, 'mouthFrown_R', frown * 0.92 + Math.max(0, leftBias));
  setMorph(targets, 'mouthPress_L', tension * 0.48);
  setMorph(targets, 'mouthPress_R', tension * 0.48);
  setMorph(targets, 'mouthDimple_L', tension * smile * 0.34);
  setMorph(targets, 'mouthDimple_R', tension * smile * 0.34);

  switch (mouth.state) {
    case 'slight opening':
      setMorph(targets, 'jawOpen', 0.28 + tension * 0.28);
      setMorph(targets, 'mouthFunnel', 0.08 + frown * 0.18);
      break;
    case 'smile':
      setMorph(targets, 'mouthSmile_L', Math.max(0.42, smile));
      setMorph(targets, 'mouthSmile_R', Math.max(0.42, smile));
      setMorph(targets, 'cheekSquint_L', 0.12 + smile * 0.26);
      setMorph(targets, 'cheekSquint_R', 0.12 + smile * 0.26);
      break;
    case 'pressed lips':
      setMorph(targets, 'mouthClose', 0.2);
      setMorph(targets, 'mouthPress_L', 0.24 + tension * 0.22);
      setMorph(targets, 'mouthPress_R', 0.24 + tension * 0.22);
      break;
    case 'trembling':
      setMorph(targets, 'jawOpen', 0.12);
      setMorph(targets, 'mouthFrown_L', frown + 0.22);
      setMorph(targets, 'mouthFrown_R', frown + 0.3);
      setMorph(targets, 'mouthLowerDown_L', 0.18);
      setMorph(targets, 'mouthLowerDown_R', 0.26);
      break;
    default:
      break;
  }

  const muscleTension = clamp(face.muscleTension / 100);
  setMorph(targets, 'cheekSquint_L', muscleTension * 0.22 + smile * 0.18);
  setMorph(targets, 'cheekSquint_R', muscleTension * 0.22 + smile * 0.18);
  setMorph(targets, 'noseSneer_L', muscleTension * frown * 0.32);
  setMorph(targets, 'noseSneer_R', muscleTension * frown * 0.32);
  setMorph(targets, 'mouthStretch_L', muscleTension * frown * 0.14);
  setMorph(targets, 'mouthStretch_R', muscleTension * frown * 0.14);

  return targets;
};

const disposeObject = (object: THREE.Object3D) => {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    materials.forEach((material) => {
      const materialRecord = material as THREE.Material & Record<string, unknown>;
      Object.values(materialRecord).forEach((value) => {
        if (value instanceof THREE.Texture) value.dispose();
      });
      material.dispose();
    });
  });
};

/** 资源损坏或 WebGL 解码器不可用时的本地灰模兜底，保证控制台仍可操作。 */
const createProceduralFace = (): {
  object: THREE.Group;
  parts: ProceduralFace;
  pupils: THREE.Mesh[];
  materials: THREE.MeshStandardMaterial[];
} => {
  const object = new THREE.Group();
  const materials: THREE.MeshStandardMaterial[] = [];
  const clay = new THREE.MeshStandardMaterial({ color: 0xc8c9c9, roughness: 0.82 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x30343b, roughness: 0.6 });
  const eyeWhite = new THREE.MeshStandardMaterial({ color: 0xe9ebee, roughness: 0.45 });
  materials.push(clay, dark, eyeWhite);

  const head = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), clay);
  head.scale.set(1.02, 1.18, 0.9);
  head.position.y = 0.58;
  object.add(head);

  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.32, 0.22, 40), clay);
  neck.position.set(0, -0.65, -0.08);
  object.add(neck);

  const jaw = new THREE.Group();
  const mouth = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), dark);
  mouth.scale.set(0.28, 0.045, 0.035);
  mouth.position.set(0, 0.08, 0.86);
  jaw.add(mouth);
  const lowerLip = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), clay);
  lowerLip.scale.set(0.2, 0.028, 0.025);
  lowerLip.position.set(0, 0.01, 0.88);
  jaw.add(lowerLip);
  jaw.position.y = 0.08;
  object.add(jaw);

  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.3, 24), clay);
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, 0.48, 0.86);
  object.add(nose);

  const leftBrow = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.055, 0.055), dark);
  const rightBrow = leftBrow.clone();
  leftBrow.position.set(-0.29, 0.93, 0.82);
  rightBrow.position.set(0.29, 0.93, 0.82);
  object.add(leftBrow, rightBrow);

  const pupilGroup = new THREE.Group();
  const pupils: THREE.Mesh[] = [];
  [-1, 1].forEach((direction) => {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.14, 24, 16), eyeWhite);
    eye.position.set(direction * 0.3, 0.62, 0.79);
    pupilGroup.add(eye);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.065, 20, 14), dark);
    pupil.position.set(direction * 0.3, 0.62, 0.91);
    pupilGroup.add(pupil);
    pupils.push(pupil);
  });
  object.add(pupilGroup);

  return { object, parts: { head, leftBrow, rightBrow, jaw, mouth }, pupils, materials };
};

export const ThreeMannequinViewport: React.FC<ThreeMannequinViewportProps> = ({
  facialState,
  gender,
  emotionName,
  showMesh = false,
}) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const targetMorphs = useMemo(() => buildMorphTargets(facialState), [facialState]);
  const livePropsRef = useRef({ targetMorphs, gender, facialState, showMesh });
  const [status, setStatus] = useState<'loading' | 'ready'>('loading');

  livePropsRef.current = { targetMorphs, gender, facialState, showMesh };

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;

    let disposed = false;
    let animationFrame = 0;
    let loadedScene: THREE.Object3D | null = null;
    let proceduralFace: ProceduralFace | null = null;
    let pupilGroup: THREE.Group | null = null;
    let lastGender: MannequinGender | null = null;
    let lastWireframe: boolean | null = null;
    let faceSize: THREE.Vector3 | null = null;
    let realisticHead = false;
    const clock = new THREE.Clock();
    const morphMeshes: MorphMesh[] = [];
    const pupilMeshes: THREE.Mesh[] = [];
    const allMaterials = new Set<THREE.MeshStandardMaterial>();

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    renderer.setClearColor(0x222224, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x222224);
    scene.fog = new THREE.Fog(0x222224, 5, 16);
    const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
    const poseGroup = new THREE.Group();
    scene.add(poseGroup);

    scene.add(new THREE.HemisphereLight(0xf3f5ff, 0x24252b, 2.2));
    const keyLight = new THREE.DirectionalLight(0xffffff, 3.7);
    keyLight.position.set(-3.5, 4.8, 5.6);
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0xaebbd2, 1.7);
    fillLight.position.set(4.6, 1.4, 3.2);
    scene.add(fillLight);
    const rimLight = new THREE.DirectionalLight(0xffffff, 1.45);
    rimLight.position.set(0, 4.2, -4.8);
    scene.add(rimLight);

    const resize = () => {
      const { width, height } = host.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      if (faceSize) frameFaceCamera(camera, faceSize);
      else camera.updateProjectionMatrix();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    resize();

    const fitCamera = (object: THREE.Object3D, focusBox?: THREE.Box3) => {
      const box = focusBox ?? new THREE.Box3().setFromObject(object);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      object.position.sub(center);
      // 只在载入时居中；窗口缩放只重新计算相机，不累计移动模型。
      faceSize = size;
      frameFaceCamera(camera, size);
    };

    const addNeckAndEyes = (
      object: THREE.Object3D,
      headBox: THREE.Box3,
      eyeBounds: THREE.Box3[]
    ) => {
      const size = headBox.getSize(new THREE.Vector3());
      const center = headBox.getCenter(new THREE.Vector3());
      const clayMaterial = new THREE.MeshStandardMaterial({
        color: 0xc8c9c9,
        roughness: 0.82,
        metalness: 0,
      });
      allMaterials.add(clayMaterial);

      // 只保留细颈残端衬托头部；避免宽颈底被误读为肩膀，突出脸部。
      const neck = new THREE.Mesh(
        new THREE.CylinderGeometry(size.x * 0.15, size.x * 0.17, size.y * 0.09, 64, 3),
        clayMaterial
      );
      neck.position.set(center.x, headBox.min.y - size.y * 0.02, center.z - size.z * 0.16);
      object.add(neck);

      pupilGroup = new THREE.Group();
      const irisMaterial = new THREE.MeshStandardMaterial({
        color: 0x8f969f,
        roughness: 0.5,
        metalness: 0,
      });
      const pupilMaterial = new THREE.MeshBasicMaterial({ color: 0x111318 });
      const fallbackEyeY = center.y - size.y * 0.035;
      const fallbackEyeZ = headBox.max.z - size.z * 0.12;
      const fallbackSpread = size.x * 0.165;
      const orderedEyeBounds = eyeBounds
        .slice(0, 2)
        .sort((left, right) => left.getCenter(new THREE.Vector3()).x - right.getCenter(new THREE.Vector3()).x);
      const irisRadius = size.x * 0.032;
      const pupilRadius = irisRadius * 0.48;

      [-1, 1].forEach((direction, index) => {
        const eyeBox = orderedEyeBounds[index];
        const eyeCenter = eyeBox?.getCenter(new THREE.Vector3());
        const eyeX = eyeCenter?.x ?? center.x + fallbackSpread * direction;
        const eyeY = eyeCenter?.y ?? fallbackEyeY;
        const eyeZ = eyeBox ? eyeBox.max.z + size.z * 0.006 : fallbackEyeZ;
        const iris = new THREE.Mesh(new THREE.CircleGeometry(irisRadius, 40), irisMaterial);
        iris.position.set(eyeX, eyeY, eyeZ);
        pupilGroup?.add(iris);
        const pupil = new THREE.Mesh(new THREE.CircleGeometry(pupilRadius, 32), pupilMaterial);
        pupil.position.set(eyeX, eyeY, eyeZ + size.z * 0.004);
        pupilGroup?.add(pupil);
        pupilMeshes.push(pupil);
      });
      object.add(pupilGroup);
    };

    const ktx2Loader = new KTX2Loader()
      .setTranscoderPath('/xiaoluo/basis/')
      .detectSupport(renderer);
    const loader = new GLTFLoader();
    loader.setKTX2Loader(ktx2Loader);
    loader.setMeshoptDecoder(MeshoptDecoder);
    const loadFaceCap = () => loader.load(
      '/xiaoluo/models/facecap.glb',
      (gltf) => {
        if (disposed) {
          disposeObject(gltf.scene);
          return;
        }
        loadedScene = gltf.scene;
        const headBox = new THREE.Box3().setFromObject(loadedScene);
        const eyeBounds: THREE.Box3[] = [];
        loadedScene.traverse((child) => {
          const mesh = child as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.frustumCulled = false;
          if (mesh.geometry.getAttribute('position')?.count === 530) {
            eyeBounds.push(new THREE.Box3().setFromObject(mesh));
          }
          const sourceMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          const materials = sourceMaterials.map((sourceMaterial) => {
            const material = sourceMaterial.clone() as THREE.MeshStandardMaterial;
            material.map = null;
            material.normalMap = null;
            material.color.setHex(0xc8c9c9);
            material.roughness = 0.78;
            material.metalness = 0;
            material.envMapIntensity = 0.35;
            material.needsUpdate = true;
            allMaterials.add(material);
            return material;
          });
          mesh.material = Array.isArray(mesh.material) ? materials : materials[0];
          if (mesh.morphTargetDictionary && mesh.morphTargetInfluences) {
            // 细分只发生在载入时；形态名和权重索引保持一致，动画帧不重新建网格。
            const original = mesh.geometry;
            mesh.geometry = refineFaceGeometry(original);
            original.dispose();
            const morphMesh = mesh as MorphMesh;
            morphMeshes.push(morphMesh);
          }
        });
        addNeckAndEyes(loadedScene, headBox, eyeBounds);
        poseGroup.add(loadedScene);
        fitCamera(loadedScene, headBox);
        setStatus('ready');
      },
      undefined,
      (error) => {
        // FaceCap 资源可能因本地缓存或文件不完整而无法解码，控制台仍保留可追踪信息，界面使用灰模继续工作。
        console.warn('FaceCap 面部模型不可用，已切换到通用灰模预览。', error);
        if (disposed) return;
        const fallback = createProceduralFace();
        loadedScene = fallback.object;
        proceduralFace = fallback.parts;
        pupilGroup = fallback.object.children.find(
          (child): child is THREE.Group => child instanceof THREE.Group && child.children.length === 4,
        ) ?? null;
        pupilMeshes.push(...fallback.pupils);
        fallback.materials.forEach((material) => allMaterials.add(material));
        poseGroup.add(fallback.object);
        fitCamera(fallback.object, new THREE.Box3().setFromObject(fallback.parts.head));
        setStatus('ready');
      }
    );

    // 优先加载高精度真人头模（按性别选模型）；失败退回灰模 facecap，再失败退回程序化几何。
    const hdUrl = gender === 'male' ? HD_MODEL_MALE_URL : HD_MODEL_FEMALE_URL;
    loader.load(
      hdUrl,
      (gltf) => {
        if (disposed) {
          disposeObject(gltf.scene);
          return;
        }
        realisticHead = true;
        loadedScene = gltf.scene;
        loadedScene.traverse((child) => {
          const mesh = child as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.frustumCulled = false;
          // 隐藏躯干、四肢、服装，只留头/眼/牙/发，突出脸部。
          if (HD_HIDDEN_MESH.test(mesh.name)) {
            mesh.visible = false;
            return;
          }
          const sourceMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          sourceMaterials.forEach((material) => {
            if ((material as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
              allMaterials.add(material as THREE.MeshStandardMaterial);
            }
          });
          if (mesh.morphTargetDictionary && mesh.morphTargetInfluences) {
            morphMeshes.push(mesh as MorphMesh);
          }
        });
        // 取景盒只包含带表情形态的头部网格（头/眼/牙），排除头发等溢出包围盒。
        const headBox = new THREE.Box3();
        loadedScene.traverse((child) => {
          const mesh = child as THREE.Mesh;
          if (mesh.isMesh && mesh.visible && mesh.morphTargetDictionary) {
            headBox.expandByObject(mesh);
          }
        });
        poseGroup.add(loadedScene);
        fitCamera(loadedScene, headBox);
        setStatus('ready');
      },
      undefined,
      (error) => {
        console.warn('高精度头模不可用，回退灰模 facecap 预览。', error);
        if (disposed) return;
        loadFaceCap();
      }
    );

    const animate = () => {
      if (disposed) return;
      animationFrame = window.requestAnimationFrame(animate);
      const delta = Math.min(clock.getDelta(), 0.05);
      const elapsed = clock.elapsedTime;
      const {
        targetMorphs: morphTargets,
        gender: liveGender,
        facialState: liveState,
        showMesh: wireframe,
      } = livePropsRef.current;

      morphMeshes.forEach((mesh) => {
        Object.entries(mesh.morphTargetDictionary).forEach(([name, index]) => {
          const desired = morphTargets[name] ?? morphTargets[toUnderscoreMorph(name)] ?? 0;
          mesh.morphTargetInfluences[index] = THREE.MathUtils.damp(
            mesh.morphTargetInfluences[index] ?? 0,
            desired,
            10,
            delta
          );
        });
      });

      // 真人头模保留原贴图肤色/发色，不做灰模染色；仅灰模按性别改色。
      if (!realisticHead && liveGender !== lastGender) {
        const clayColor = liveGender === 'male' ? 0xb9c1ca : 0xd9c4bc;
        allMaterials.forEach((material) => material.color.setHex(clayColor));
        lastGender = liveGender;
      }
      if (wireframe !== lastWireframe) {
        allMaterials.forEach((material) => {
          material.wireframe = wireframe;
          material.needsUpdate = true;
        });
        lastWireframe = wireframe;
      }

      // 灰模只有一套网格，用体型缩放区分男女；真人头模保持原比例，不做各向异性拉伸。
      const targetScaleX = realisticHead ? 1 : liveGender === 'male' ? 1.16 : 0.84;
      const targetScaleY = realisticHead ? 1 : liveGender === 'male' ? 0.98 : 1.06;
      const targetScaleZ = realisticHead ? 1 : liveGender === 'male' ? 1.04 : 0.96;
      poseGroup.scale.x = THREE.MathUtils.damp(poseGroup.scale.x, targetScaleX, 8, delta);
      poseGroup.scale.y = THREE.MathUtils.damp(poseGroup.scale.y, targetScaleY, 8, delta);
      poseGroup.scale.z = THREE.MathUtils.damp(poseGroup.scale.z, targetScaleZ, 8, delta);
      // 真人头模切换情绪时保持正视，不跟随 headTilt 左右歪；仅灰模保留轻微头部倾斜。
      const tiltTarget = realisticHead ? 0 : THREE.MathUtils.degToRad(liveState.face.headTilt * 0.72);
      poseGroup.rotation.z = THREE.MathUtils.damp(poseGroup.rotation.z, tiltTarget, 7, delta);
      const breathingSpeed = liveState.face.breathing === 'fast breathing' ? 3.2 : 1.35;
      const breathingAmount = liveState.face.breathing === 'holding breath' ? 0 : 0.0045;
      poseGroup.position.y = Math.sin(elapsed * breathingSpeed) * breathingAmount;

      if (pupilGroup) {
        const horizontalTarget = liveState.eye.direction === 'side'
          ? 0.018
          : liveState.eye.direction === 'avoid gaze'
            ? -0.014
            : 0;
        const verticalTarget = liveState.eye.direction === 'up'
          ? 0.012
          : liveState.eye.direction === 'down'
            ? -0.014
            : 0;
        pupilGroup.position.x = THREE.MathUtils.damp(pupilGroup.position.x, horizontalTarget, 12, delta);
        pupilGroup.position.y = THREE.MathUtils.damp(pupilGroup.position.y, verticalTarget, 12, delta);
        const pupilScale = 1 + clamp((liveState.face.pupilSize ?? 0) / 50, -1, 1) * 0.32;
        pupilMeshes.forEach((pupil) => pupil.scale.setScalar(pupilScale));
      }

      if (proceduralFace) {
        const browHeight = clamp(liveState.eyebrow.height / 50, -1, 1);
        const browTension = clamp(liveState.eyebrow.tension / 100);
        proceduralFace.leftBrow.position.y = 0.93 + browHeight * 0.1;
        proceduralFace.rightBrow.position.y = 0.93 + browHeight * 0.1;
        proceduralFace.leftBrow.rotation.z = -browTension * 0.24;
        proceduralFace.rightBrow.rotation.z = browTension * 0.24;
        proceduralFace.jaw.position.y = 0.08 - clamp(liveState.face.muscleTension / 100) * 0.06;
        const mouthCurve = clamp(liveState.mouth.curve / 100, -1, 1);
        const mouthTension = clamp(liveState.mouth.tension / 100);
        proceduralFace.mouth.scale.x = 0.28 + Math.abs(mouthCurve) * 0.07;
        proceduralFace.mouth.scale.y = 0.045 + mouthTension * 0.035 + Math.max(0, mouthCurve) * 0.025;
      }

      renderer.render(scene, camera);
    };
    animate();

    return () => {
      disposed = true;
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      ktx2Loader.dispose();
      if (loadedScene) disposeObject(loadedScene);
      renderer.dispose();
    };
    // gender 变化时重建场景并加载对应性别的头模；其余实时属性走 livePropsRef，不触发重建。
  }, [gender]);

  return (
    <div
      ref={hostRef}
      role="img"
      aria-label={`${gender === 'female' ? '女性' : '男性'}实时三维灰模：${emotionName ?? '动态表情'}`}
      className="relative h-full w-full select-none overflow-hidden bg-[#222224]"
    >
      <canvas
        ref={canvasRef}
        data-mannequin-canvas="true"
        className="block h-full w-full contrast-[1.04]"
      />

      {status === 'loading' && (
        <div className="absolute inset-0 grid place-items-center bg-[#222224] text-sm font-medium text-white/60">
          正在加载 3D 面部模型…
        </div>
      )}

      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_43%,transparent_48%,rgba(0,0,0,0.2)_100%)]" />
    </div>
  );
};

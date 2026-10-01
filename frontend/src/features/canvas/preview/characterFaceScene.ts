import * as pc from "playcanvas";
import type { CharacterPerformance } from "@/features/canvas/domain/canvasNodes";

export interface CharacterFacePose {
  browY: number;
  browTilt: number;
  eyeHeight: number;
  lidHeight: number;
  mouthWidth: number;
  mouthHeight: number;
  mouthTilt: number;
  jawDrop: number;
}

export function deriveCharacterFacePose(value: CharacterPerformance): CharacterFacePose {
  const clamp = (number: number) => Math.min(1, Math.max(-1, number));
  const brows = clamp(value.brows);
  const eyes = clamp(value.eyes);
  const mouth = clamp(value.mouth);
  const jaw = clamp(value.jaw);
  return {
    browY: 0.045 * brows,
    browTilt: -0.22 * brows,
    eyeHeight: 0.075 + 0.055 * eyes,
    lidHeight: 0.12 - 0.08 * ((eyes + 1) / 2),
    mouthWidth: 0.15 + 0.045 * Math.abs(mouth),
    mouthHeight: 0.018 + 0.065 * Math.max(0, mouth) + 0.035 * Math.max(0, jaw),
    mouthTilt: -0.14 * mouth,
    jawDrop: 0.055 * jaw,
  };
}

export interface CharacterFaceScene {
  update: (performance: CharacterPerformance) => void;
  destroy: () => void;
}

function flatMaterial(color: pc.Color): pc.StandardMaterial {
  const material = new pc.StandardMaterial();
  material.diffuse = color.clone();
  material.metalness = 0;
  material.update();
  return material;
}

export function createCharacterFaceScene(app: pc.Application): CharacterFaceScene {
  const skin = flatMaterial(new pc.Color(0.62, 0.58, 0.54));
  const skinLight = flatMaterial(new pc.Color(0.72, 0.68, 0.63));
  const feature = flatMaterial(new pc.Color(0.08, 0.075, 0.07));
  const eyeWhite = flatMaterial(new pc.Color(0.88, 0.88, 0.86));
  const iris = flatMaterial(new pc.Color(0.18, 0.2, 0.22));
  const mouthInner = flatMaterial(new pc.Color(0.2, 0.08, 0.09));
  const materials = [skin, skinLight, feature, eyeWhite, iris, mouthInner];
  const entities: pc.Entity[] = [];
  const addSphere = (name: string, material: pc.StandardMaterial, position: [number, number, number], scale: [number, number, number]) => {
    const entity = new pc.Entity(name);
    entity.addComponent("render", { type: "sphere", material });
    entity.setLocalPosition(...position);
    entity.setLocalScale(...scale);
    app.root.addChild(entity);
    entities.push(entity);
    return entity;
  };

  const camera = new pc.Entity("face_preview_camera");
  camera.addComponent("camera", {
    clearColor: new pc.Color(0.07, 0.085, 0.105),
    fov: 32,
    nearClip: 0.1,
    farClip: 20,
  });
  camera.setLocalPosition(0, 0.05, 4.5);
  camera.lookAt(0, 0, 0);
  app.root.addChild(camera);
  entities.push(camera);

  const light = new pc.Entity("face_preview_light");
  light.addComponent("light", { type: "directional", color: new pc.Color(1, 0.96, 0.9), intensity: 1.35, castShadows: false });
  light.setEulerAngles(25, 0, 0);
  app.root.addChild(light);
  entities.push(light);

  addSphere("face_shoulders", skin, [0, -1.17, 0.02], [1.15, 0.42, 0.42]);
  addSphere("face_neck", skin, [0, -0.82, 0.02], [0.35, 0.45, 0.35]);
  addSphere("face_head", skinLight, [0, 0, 0], [0.79, 1.03, 0.63]);
  const jaw = addSphere("face_jaw", skin, [0, -0.52, 0.43], [0.52, 0.35, 0.21]);
  addSphere("face_nose_bridge", skinLight, [0, -0.02, 0.61], [0.09, 0.25, 0.12]);
  addSphere("face_nose_tip", skinLight, [0, -0.15, 0.68], [0.13, 0.1, 0.13]);
  [-1, 1].forEach((side) => addSphere("face_ear", skin, [side * 0.76, -0.02, 0.02], [0.12, 0.3, 0.16]));
  const brows = [-1, 1].map((side) => addSphere("face_brow", feature, [side * 0.28, 0.22, 0.55], [0.19, 0.045, 0.035]));
  const eyes = [-1, 1].map((side) => addSphere("face_eye", eyeWhite, [side * 0.28, 0.105, 0.565], [0.17, 0.075, 0.045]));
  const lids = [-1, 1].map((side) => addSphere("face_lid", skin, [side * 0.28, 0.17, 0.595], [0.18, 0.02, 0.035]));
  const pupils = [-1, 1].map((side) => addSphere("face_pupil", iris, [side * 0.28, 0.105, 0.61], [0.045, 0.055, 0.025]));
  const mouth = addSphere("face_mouth", mouthInner, [0, -0.27, 0.585], [0.15, 0.018, 0.03]);

  const update = (performance: CharacterPerformance) => {
    const pose = deriveCharacterFacePose(performance);
    brows.forEach((brow, index) => {
      const side = index === 0 ? -1 : 1;
      brow.setLocalPosition(side * 0.28, 0.22 + pose.browY, 0.55);
      brow.setLocalEulerAngles(0, 0, side * pose.browTilt);
    });
    eyes.forEach((eye) => eye.setLocalScale(0.17, pose.eyeHeight, 0.045));
    lids.forEach((lid, index) => {
      lid.setLocalScale(0.18, pose.lidHeight, 0.035);
      lid.setLocalPosition(index === 0 ? -0.28 : 0.28, 0.18 + pose.lidHeight * 0.42, 0.595);
    });
    pupils.forEach((pupil) => pupil.setLocalPosition(pupil.getLocalPosition().x, 0.105, 0.61));
    mouth.setLocalScale(pose.mouthWidth, pose.mouthHeight, 0.03);
    mouth.setLocalEulerAngles(0, 0, pose.mouthTilt);
    jaw.setLocalPosition(0, -0.52 - pose.jawDrop, 0.43 + pose.jawDrop * 0.25);
  };

  update({ valence: 0, arousal: 0, brows: 0, eyes: 0, mouth: 0, jaw: 0 });
  return {
    update,
    destroy: () => {
      entities.forEach((entity) => entity.destroy());
      materials.forEach((material) => material.destroy());
    },
  };
}

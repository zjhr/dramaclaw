/** 身份设计的点选。这些词会写进身份图的提示词，不写进视频提示词。 */

export const LOOK_MAKEUP = [
  "无妆原生",
  "素颜",
  "清透底妆",
  "水光肌",
  "哑光",
  "日常淡妆",
  "自然修容",
  "明艳红唇",
  "烟熏",
  "新娘妆",
  "古风妆",
  "舞台妆",
  "浓妆",
  "战损妆",
  "淤青",
  "旧疤",
  "哭花妆",
  "汗湿",
  "苍白",
  "黑眼圈",
  "病容",
  "晒伤",
  "醉容",
] as const;

export const LOOK_CLOTHING = [
  "白衬衫",
  "黑T恤",
  "白上衣",
  "黑上衣",
  "针织衫",
  "卫衣",
  "西装",
  "风衣",
  "大衣",
  "夹克",
  "连衣裙",
  "长裙",
  "短裙",
  "校服",
  "制服",
  "工装",
  "睡衣",
  "运动装",
  "礼服",
  "汉服",
  "旗袍",
  "古装",
  "盔甲",
  "破旧衣",
] as const;

export const LOOK_ACCESSORIES = [
  "无配饰",
  "细框眼镜",
  "墨镜",
  "小银耳饰",
  "珍珠耳钉",
  "金色耳圈",
  "耳钉",
  "项链",
  "锁骨链",
  "帽子",
  "棒球帽",
  "手表",
  "手链",
  "戒指",
  "发夹",
  "发带",
  "围巾",
  "口罩",
  "耳机",
  "背包",
] as const;

export const LOOK_FACE_SHAPES = ["鹅蛋脸", "圆脸", "方脸", "长脸", "瓜子脸", "菱形脸"] as const;
export const LOOK_EYES = ["杏眼", "圆眼", "丹凤眼", "细长眼", "下垂眼", "双眼皮", "单眼皮"] as const;
export const LOOK_EYEBROWS = ["平眉", "挑眉", "浓眉", "细眉", "剑眉"] as const;
export const LOOK_NOSES = ["高鼻梁", "小巧鼻", "宽鼻", "驼峰鼻"] as const;
export const LOOK_LIPS = ["薄唇", "厚唇", "嘴角上扬", "嘴角下垂", "花瓣唇"] as const;
export const LOOK_BODIES = ["纤细", "标准", "高挑", "娇小", "丰满", "壮实", "瘦高", "少年", "儿童", "老年"] as const;
export const LOOK_HAIR = [
  "黑长直",
  "黑短发",
  "长卷发",
  "波浪卷",
  "马尾",
  "双马尾",
  "丸子头",
  "寸头",
  "中分",
  "侧分",
  "齐刘海",
  "盘发",
  "白发",
  "金发",
  "棕发",
  "红发",
  "银发",
  "光头",
] as const;
export const LOOK_STYLES = [
  "写实",
  "电影感",
  "日漫",
  "国漫",
  "韩漫",
  "水彩",
  "赛博",
  "古风",
  "民国",
  "现代都市",
  "奇幻",
  "暗黑",
] as const;

export const ACCESSORY_LIMIT = 3;

export type IdentityLookDesign = {
  makeup: string;
  clothing: string;
  accessories: string[];
  face_shape: string;
  eyes: string;
  eyebrows: string;
  nose: string;
  lips: string;
  body: string;
  hair: string;
  style: string;
  expression: string;
};

export const EMPTY_LOOK: IdentityLookDesign = {
  makeup: "",
  clothing: "",
  accessories: [],
  face_shape: "",
  eyes: "",
  eyebrows: "",
  nose: "",
  lips: "",
  body: "",
  hair: "",
  style: "",
  expression: "",
};

export function normalizeLookDesign(raw: Partial<IdentityLookDesign> | null | undefined): IdentityLookDesign {
  const source = raw ?? {};
  const accessories = Array.isArray(source.accessories)
    ? source.accessories.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
  return {
    ...EMPTY_LOOK,
    makeup: typeof source.makeup === "string" ? source.makeup : "",
    clothing: typeof source.clothing === "string" ? source.clothing : "",
    face_shape: typeof source.face_shape === "string" ? source.face_shape : "",
    eyes: typeof source.eyes === "string" ? source.eyes : "",
    eyebrows: typeof source.eyebrows === "string" ? source.eyebrows : "",
    nose: typeof source.nose === "string" ? source.nose : "",
    lips: typeof source.lips === "string" ? source.lips : "",
    body: typeof source.body === "string" ? source.body : "",
    hair: typeof source.hair === "string" ? source.hair : "",
    style: typeof source.style === "string" ? source.style : "",
    expression: typeof source.expression === "string" ? source.expression : "",
    accessories: accessories.includes("无配饰") ? ["无配饰"] : accessories.slice(0, ACCESSORY_LIMIT),
  };
}

/**
 * NDS路由
 */
import { Router } from "express";
import { NDSController } from "../controllers/nds";

// 创建路由实例
const router = Router();
// 自定义路由路径
export const routePath = "/nds";

// 获取NDS列表
router.get("/list", NDSController.list);

// 获取单个NDS
router.get("/:id", NDSController.get);

// 创建NDS
router.post("/", NDSController.create);

// 更新NDS
router.put("/:id", NDSController.update);

// 删除NDS
router.delete("/:id", NDSController.delete);

export default router;
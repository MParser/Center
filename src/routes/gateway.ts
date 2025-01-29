/**
 * 网关路由
 */
import { Router } from "express";
import { GatewayController } from "../controllers/gateway";

// 创建路由实例
const router = Router();
// 自定义路由路径（可选）
export const routePath = "/gateway";

// 获取网关列表
router.get("/list", GatewayController.list);

// 获取单个网关
router.get("/:id", GatewayController.get);

// 注册网关
router.post("/register", GatewayController.reg);

// 更新网关
router.put("/:id", GatewayController.update);

// 删除网关
router.delete("/:id", GatewayController.delete);

// 设置网关关联的NDS
router.post("/:id/nds", GatewayController.setNDS);

export default router;

/**
 * NDS文件相关路由
 */
import { Router } from "express";
import { NDSFileController } from "../controllers/ndsfiles";

// 创建路由实例
const router = Router();

// 自定义路由路径
export const routePath = "/ndsfiles";

// 查找不存在的文件路径
router.post("/filter", NDSFileController.filterFiles);

router.post("/batchAddTasks", NDSFileController.batchAddTasks);


export default router;
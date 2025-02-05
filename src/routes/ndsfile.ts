/**
 * NDS文件相关路由
 */
import { Router } from "express";
import { NDSFileController } from "../controllers/ndsfile";

// 创建路由实例
const router = Router();

// 自定义路由路径
export const routePath = "/ndsfile";

// 获取文件路径列表
router.get("/:ndsId/paths", NDSFileController.getFilePaths);

// 查找不存在的文件路径
router.post("/filter-files", NDSFileController.filterFiles);

// 批量添加NDS文件
router.post("/batch", NDSFileController.batchAdd);

// 批量设置文件为已移除状态
router.post("/remove", NDSFileController.remove);

// 设置文件解析状态
router.post("/parsed", NDSFileController.setParsedStatus);

// 获取Redis内存状态
router.get('/memory-info', NDSFileController.getRedisMemoryInfo);

export default router;
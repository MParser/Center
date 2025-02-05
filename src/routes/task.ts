/**
 * 任务路由
 */
import { Router } from 'express';
import { TaskController } from '../controllers/task';

const router = Router();

// 获取任务列表
router.get('/', TaskController.list);

// 获取任务详情
router.get('/:id', TaskController.get);

// 创建任务
router.post('/', TaskController.create);

// 删除任务
router.delete('/:id', TaskController.delete);

// 检查时间范围
router.get('/check', TaskController.checkTime);

export default router;

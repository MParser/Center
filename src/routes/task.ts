/**
 * 任务路由
 */
import { Router } from 'express';
import { TaskController } from '../controllers/task';

const router = Router();

// 获取任务列表
router.get('/', TaskController.list);

// 检查时间范围
router.get('/check', TaskController.checkTime);

// 获取去重时间范围 getTimeRange
router.get('/getTimeRange', TaskController.getTimeRange);

// 获取任务详情
router.get('/:id', TaskController.get);

// 创建任务
router.post('/', TaskController.create);

// 删除任务
router.delete('/:id', TaskController.delete);


export default router;

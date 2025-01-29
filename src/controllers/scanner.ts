/**
 * Scanner控制器
 */
import { Request, Response } from 'express';
import mysql from '../database/mysql';
import logger from '../utils/logger';

// 定义请求体接口
interface SetNDSRequestBody {
    ndsIds: number[];
}

interface SetGatewayRequestBody {
    gatewayId: string;
}

export class ScannerController {
    static async list(_req: Request, res: Response): Promise<void> {
        try {
            const scanners = await mysql.scannerList.findMany({
                include: {
                    gateway: true,
                    ndsLinks: {
                        include: {
                            nds: true
                        }
                    }
                }
            });
            res.success(scanners, '获取Scanner列表成功');
        } catch (error: any) {
            logger.error('获取Scanner列表失败:', error);
            res.internalError('获取Scanner列表失败');
        }
    }

    static async get(req: Request, res: Response): Promise<void> {
        try {
            const id = req.params.id;
            const scanner = await mysql.scannerList.findUnique({ 
                where: { id },
                include: {
                    gateway: true,
                    ndsLinks: {
                        include: {
                            nds: true
                        }
                    }
                }
            });
            if (scanner) {
                res.success(scanner, '获取Scanner成功');
            } else {
                res.notFound('Scanner不存在');
            }
        } catch (error: any) {
            res.internalError('获取Scanner失败');
        }
    }

    static async reg(req: Request, res: Response): Promise<void> {
        try {
            const data = req.body;
            
            // 先判断Scanner是否存在
            const scanner = await mysql.scannerList.findUnique({ where: { id: data.id } });
            if (scanner) {
                // 存在则更新Scanner状态(status = 1)以及port端口
                await mysql.scannerList.update({
                    where: { id: data.id },
                    data: { status: 1, port: data.port }
                });
                res.success(scanner, '注册Scanner成功');
            } else {
                // 不存在则添加Scanner,从req.requestInfo中获取IP地址，添加进data中
                data.host = req.requestInfo.ip;
                data.switch = 0;
                const newScanner = await mysql.scannerList.create({ data });
                res.success(newScanner, "注册Scanner成功");
            }
        } catch (error: any) {
            logger.error('注册Scanner失败:', error);
            res.internalError('注册Scanner失败');
        }
    }

    static async update(req: Request, res: Response): Promise<void> {
        try {
            const id = req.params.id;
            const data = req.body;
            
            // 如果要更新gatewayId，先验证Gateway是否存在
            if (data.gatewayId) {
                const gateway = await mysql.gatewayList.findUnique({ 
                    where: { id: data.gatewayId } 
                });
                
                if (!gateway) {
                    return res.badRequest('指定的Gateway不存在');
                }
            }

            const scanner = await mysql.scannerList.update({
                where: { id },
                data,
                include: {
                    gateway: true,
                    ndsLinks: {
                        include: {
                            nds: true
                        }
                    }
                }
            });
            res.success(scanner, '更新Scanner成功');
        } catch (error: any) {
            logger.error('更新Scanner失败:', error);
            res.internalError('更新Scanner失败');
        }
    }

    static async delete(req: Request, res: Response): Promise<void> {
        try {
            const id = req.params.id;
            // 删除Scanner时同时删除关联的NDS记录
            await mysql.scannerNDSLink.deleteMany({
                where: { scannerId: id }
            });
            await mysql.scannerList.delete({ where: { id } });
            res.success(null, '删除Scanner成功');
        } catch (error: any) {
            logger.error('删除Scanner失败:', error);
            res.internalError('删除Scanner失败');
        }
    }

    /**
     * 设置Scanner关联的Gateway
     */
    static async setGateway(req: Request<{ id: string }, any, SetGatewayRequestBody>, res: Response): Promise<void> {
        try {
            const scannerId = req.params.id;
            const { gatewayId } = req.body;

            // 验证Scanner是否存在
            const scanner = await mysql.scannerList.findUnique({ where: { id: scannerId } });
            if (!scanner) {
                return res.notFound('Scanner不存在');
            }

            // 验证Gateway是否存在
            const gateway = await mysql.gatewayList.findUnique({ where: { id: gatewayId } });
            if (!gateway) {
                return res.badRequest('指定的Gateway不存在');
            }

            // 更新Scanner的Gateway
            const updatedScanner = await mysql.scannerList.update({
                where: { id: scannerId },
                data: { gatewayId },
                include: {
                    gateway: true,
                    ndsLinks: {
                        include: {
                            nds: true
                        }
                    }
                }
            });

            // 当更换Gateway时，清除所有NDS关联
            await mysql.scannerNDSLink.deleteMany({
                where: { scannerId }
            });

            res.success(updatedScanner, '设置Scanner Gateway成功');
        } catch (error: any) {
            logger.error('设置Scanner Gateway失败:', error);
            res.internalError('设置Scanner Gateway失败');
        }
    }

    /**
     * 设置Scanner关联的NDS
     */
    static async setNDS(req: Request<{ id: string }, any, SetNDSRequestBody>, res: Response): Promise<void> {
        try {
            const scannerId = req.params.id;
            const { ndsIds } = req.body;

            // 验证Scanner是否存在
            const scanner = await mysql.scannerList.findUnique({ 
                where: { id: scannerId },
                include: { gateway: true }
            });
            
            if (!scanner) {
                return res.notFound('Scanner不存在');
            }

            // 如果Scanner没有关联的Gateway，不能设置NDS
            if (!scanner.gatewayId) {
                return res.badRequest('Scanner未关联Gateway，无法设置NDS');
            }

            // 获取Gateway关联的所有NDS
            const gatewayNDSLinks = await mysql.gatewayNDSLink.findMany({
                where: { gatewayId: scanner.gatewayId },
                select: { ndsId: true }
            });

            const gatewayNDSIds = gatewayNDSLinks.map(link => link.ndsId);

            // 检查所有要设置的NDS是否都在Gateway的NDS列表中
            const invalidNDSIds = ndsIds.filter(id => !gatewayNDSIds.includes(id));
            if (invalidNDSIds.length > 0) {
                return res.badRequest(`以下NDS不在Gateway的NDS列表中: ${invalidNDSIds.join(', ')}`);
            }

            // 验证所有NDS是否存在
            const ndsList = await mysql.ndsList.findMany({
                where: {
                    id: {
                        in: ndsIds
                    }
                }
            });

            if (ndsList.length !== ndsIds.length) {
                return res.badRequest('存在无效的NDS ID');
            }

            // 删除原有的关联
            await mysql.scannerNDSLink.deleteMany({
                where: { scannerId }
            });

            // 创建新的关联
            const links = ndsIds.map((ndsId: number) => ({
                scannerId,
                ndsId
            }));

            await mysql.scannerNDSLink.createMany({
                data: links
            });

            // 返回更新后的Scanner信息（包含NDS）
            const updatedScanner = await mysql.scannerList.findUnique({
                where: { id: scannerId },
                include: {
                    gateway: true,
                    ndsLinks: {
                        include: {
                            nds: true
                        }
                    }
                }
            });

            res.success(updatedScanner, '设置Scanner NDS成功');
        } catch (error: any) {
            if (error.code === 'P2002') {
                res.badRequest('存在重复的NDS关联');
            } else {
                logger.error('设置Scanner NDS失败:', error);
                res.internalError('设置Scanner NDS失败');
            }
        }
    }
}

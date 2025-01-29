/**
 * 网关控制器
 */
import { Request, Response } from 'express';
import mysql from '../database/mysql';
import logger from '../utils/logger';

// 定义请求体接口
interface SetNDSRequestBody {
    ndsIds: number[];
}

export class GatewayController {
    static async list(_req: Request, res: Response): Promise<void> {
        try {
            const gateways = await mysql.gatewayList.findMany({
                include: {
                    ndsLinks: {
                        include: {
                            nds: true
                        }
                    }
                }
            });
            res.success(gateways, '获取网关列表成功');
        } catch (error: any) {
            logger.error('获取网关列表失败:', error);
            res.internalError('获取网关列表失败');
        }
    }

    static async get(req: Request, res: Response): Promise<void> {
        try {
            const id = req.params.id;
            const gateway = await mysql.gatewayList.findUnique({ 
                where: { id },
                include: {
                    ndsLinks: {
                        include: {
                            nds: true
                        }
                    }
                }
            });
            if (gateway) {
                res.success(gateway, '获取网关成功');
            } else {
                res.notFound('网关不存在');
            }
        } catch (error: any) {
            res.internalError('获取网关失败');
        }
    }

    static async reg(req: Request, res: Response): Promise<void> {
        try {
            const data = req.body;
            // 先判断网关是否存在
            const gateway = await mysql.gatewayList.findUnique({ where: { id: data.id } });
            if (gateway){
                // 存在则更新网关状态(status = 1)以及port端口
                await mysql.gatewayList.update({
                    where: { id: data.id },
                    data: { status: 1, port: data.port }
                });
                res.success(gateway, '注册网关成功');
            }else {
              // 不存在则添加网关,从req.requestInfo中获取IP地址，添加进data中
              data.host = req.requestInfo.ip;
              data.switch = 0;
              const newGateway = await mysql.gatewayList.create({ data });
              res.success(newGateway, "注册网关成功");
            }
        }catch (error: any) {
            res.internalError('注册网关失败');
        }
    }

    static async update(req: Request, res: Response): Promise<void> {
        try {
            const id = req.params.id;
            const data = req.body;
            const gateway = await mysql.gatewayList.update({
                where: { id },
                data,
                include: {
                    ndsLinks: {
                        include: {
                            nds: true
                        }
                    }
                }
            });
            res.success(gateway, '更新网关成功');
        } catch (error: any) {
            res.internalError('更新网关失败');
        }
    }

    static async delete(req: Request, res: Response): Promise<void> {
        try {
            const id = req.params.id;
            // 删除网关时同时删除关联的NDS记录
            await mysql.gatewayNDSLink.deleteMany({
                where: { gatewayId: id }
            });
            await mysql.gatewayList.delete({ where: { id } });
            res.success(null, '删除网关成功');
        } catch (error: any) {
            res.internalError('删除网关失败');
        }
    }

    /**
     * 设置网关关联的NDS
     */
    static async setNDS(req: Request<{ id: string }, any, SetNDSRequestBody>, res: Response): Promise<void> {
        try {
            const gatewayId = req.params.id;
            const { ndsIds } = req.body;

            // 验证网关是否存在
            const gateway = await mysql.gatewayList.findUnique({ where: { id: gatewayId } });
            if (!gateway) {
                return res.notFound('网关不存在');
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
            await mysql.gatewayNDSLink.deleteMany({
                where: { gatewayId }
            });

            // 创建新的关联
            const links = ndsIds.map((ndsId: number) => ({
                gatewayId,
                ndsId
            }));

            await mysql.gatewayNDSLink.createMany({
                data: links
            });

            // 返回更新后的网关信息（包含NDS）
            const updatedGateway = await mysql.gatewayList.findUnique({
                where: { id: gatewayId },
                include: {
                    ndsLinks: {
                        include: {
                            nds: true
                        }
                    }
                }
            });

            res.success(updatedGateway, '设置网关NDS成功');
        } catch (error: any) {
            if (error.code === 'P2002') {
                res.badRequest('存在重复的NDS关联');
            } else {
                logger.error('设置网关NDS失败:', error);
                res.internalError('设置网关NDS失败');
            }
        }
    }
}

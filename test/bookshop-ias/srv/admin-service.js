const cds = require('@sap/cds')
const registerMcpAppPreview = require('./mcp-app-preview')

module.exports = class AdminService extends cds.ApplicationService {
  async init() {
    const { Books, Authors } = this.entities

    /** Integer-key draft roots need explicit ID generation (see schema.cds). */
    const nextIntegerId = async (entity, draftsEntity) => {
      const { ID: id1 } = await SELECT.one.from(entity).columns('max(ID) as ID')
      const { ID: id2 } = await SELECT.one.from(draftsEntity).columns('max(ID) as ID')
      return Math.max(id1 || 0, id2 || 0) + 1
    }

    this.before('NEW', Books.drafts, async (req) => {
      if (req.data.ID) return
      req.data.ID = await nextIntegerId(Books, Books.drafts)
    })

    this.before('NEW', Authors.drafts, async (req) => {
      if (req.data.ID) return
      req.data.ID = await nextIntegerId(Authors, Authors.drafts)
    })

    registerMcpAppPreview(await cds.app)

    return super.init()
  }
}

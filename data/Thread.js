const fs = require("fs");
const moment = require('moment');
const {promisify} = require('util');

const bot = require('../bot');
const knex = require('../knex');
const utils = require('../utils');
const config = require('../config');
const attachments = require('./attachments');

const ThreadMessage = require('./ThreadMessage');

const {THREAD_MESSAGE_TYPE, THREAD_STATUS} = require('./constants');

/**
 * @property {String} id
 * @property {Number} status
 * @property {String} user_id
 * @property {String} user_name
 * @property {String} channel_id
 * @property {String} created_at
 */
class Thread {
  constructor(props) {
    Object.assign(this, props);
  }

  /**
   * @param {Eris~Member} moderator
   * @param {String} text
   * @param {Eris~MessageFile[]} replyAttachments
   * @param {Boolean} isAnonymous
   * @returns {Promise<void>}
   */
  async replyToUser(moderator, text, replyAttachments = [], isAnonymous = false) {
    // Username to reply with
    let modUsername, logModUsername;
    const mainRole = utils.getMainRole(moderator);

    if (isAnonymous) {
      modUsername = (mainRole ? mainRole.name : 'Moderator');
      logModUsername = `(Anonymous) (${moderator.user.username}) ${mainRole ? mainRole.name : 'Moderator'}`;
    } else {
      const name = (config.useNicknames ? moderator.nick || moderator.user.username : moderator.user.username);
      modUsername = (mainRole ? `(${mainRole.name}) ${name}` : name);
      logModUsername = modUsername;
    }

    // Build the reply message
    let dmContent = `**${modUsername}:** ${text}`;
    let threadContent = `**${logModUsername}:** ${text}`;
    let logContent = text;

    if (config.threadTimestamps) {
      const timestamp = utils.getTimestamp();
      threadContent = `[${timestamp}] » ${threadContent}`;
    }

    // Prepare attachments, if any
    let files = [];

    if (replyAttachments.length > 0) {
      for (const attachment of replyAttachments) {
        files.push(await attachments.attachmentToFile(attachment));
        const url = await attachments.getUrl(attachment.id, attachment.filename);

        logContent += `\n\n**Attachment:** ${url}`;
      }
    }

    // Send the reply DM
    let dmMessage;
    try {
      dmMessage = await this.postToUser(dmContent, files);
    } catch (e) {
      await this.postSystemMessage(`Error while replying to user: ${e.message}`);
      return;
    }

    // Send the reply to the modmail thread
    await this.postToThreadChannel(threadContent, files);

    // Add the message to the database
    await this.addThreadMessageToDB({
      message_type: THREAD_MESSAGE_TYPE.TO_USER,
      user_id: moderator.id,
      user_name: logModUsername,
      body: logContent,
      is_anonymous: (isAnonymous ? 1 : 0),
      dm_message_id: dmMessage.id
    });
  }

  /**
   * @param {Eris~Message} msg
   * @returns {Promise<void>}
   */
  async receiveUserReply(msg) {
    let content = msg.content;
    if (msg.content.trim() === '' && msg.embeds.length) {
      content = '<message contains embeds>';
    }

    let threadContent = `**${msg.author.username}#${msg.author.discriminator}:** ${content}`;
    let logContent = msg.content;

    if (config.threadTimestamps) {
      const timestamp = utils.getTimestamp(msg.timestamp, 'x');
      threadContent = `[${timestamp}] « ${threadContent}`;
    }

    // Prepare attachments, if any
    let attachmentFiles = [];

    for (const attachment of msg.attachments) {
      await attachments.saveAttachment(attachment);

      // Forward small attachments (<2MB) as attachments, just link to larger ones
      const formatted = '\n\n' + await utils.formatAttachment(attachment);
      logContent += formatted; // Logs always contain the link

      if (config.relaySmallAttachmentsAsAttachments && attachment.size <= 1024 * 1024 * 2) {
        const file = await attachments.attachmentToFile(attachment);
        attachmentFiles.push(file);
      } else {
        threadContent += formatted;
      }
    }

    await this.postToThreadChannel(threadContent, attachmentFiles);
    await this.addThreadMessageToDB({
      message_type: THREAD_MESSAGE_TYPE.FROM_USER,
      user_id: this.user_id,
      user_name: `${msg.author.username}#${msg.author.discriminator}`,
      body: logContent,
      is_anonymous: 0,
      dm_message_id: msg.id
    });
  }

  /**
   * @returns {Promise<PrivateChannel>}
   */
  getDMChannel() {
    return bot.getDMChannel(this.user_id);
  }

  /**
   * @param {String} text
   * @param {Eris~MessageFile|Eris~MessageFile[]} file
   * @returns {Promise<Eris~Message>}
   * @throws Error
   */
  async postToUser(text, file = null) {
    // Try to open a DM channel with the user
    const dmChannel = await this.getDMChannel();
    if (! dmChannel) {
      throw new Error('Could not open DMs with the user. They may have blocked the bot or set their privacy settings higher.');
    }

    // Send the DM
    return dmChannel.createMessage(text, file);
  }

  /**
   * @returns {Promise<Eris~Message>}
   */
  async postToThreadChannel(...args) {
    try {
      return await bot.createMessage(this.channel_id, ...args);
    } catch (e) {
      // Channel not found
      if (e.code === 10003) {
        console.log(`[INFO] Auto-closing thread with ${this.user_name} because the channel no longer exists`);
        this.close(true);
      } else {
        throw e;
      }
    }
  }

  /**
   * @param {String} text
   * @returns {Promise<void>}
   */
  async postSystemMessage(text) {
    const msg = await this.postToThreadChannel(text);
    await this.addThreadMessageToDB({
      message_type: THREAD_MESSAGE_TYPE.SYSTEM,
      user_id: null,
      user_name: '',
      body: text,
      is_anonymous: 0,
      dm_message_id: msg.id
    });
  }

  /**
   * @param {String} text
   * @returns {Promise<void>}
   */
  async postNonLogMessage(...args) {
    await this.postToThreadChannel(...args);
  }

  /**
   * @param {Eris.Message} msg
   * @returns {Promise<void>}
   */
  async saveChatMessage(msg) {
    return this.addThreadMessageToDB({
      message_type: THREAD_MESSAGE_TYPE.CHAT,
      user_id: msg.author.id,
      user_name: `${msg.author.username}#${msg.author.discriminator}`,
      body: msg.content,
      is_anonymous: 0,
      dm_message_id: msg.id
    });
  }

  /**
   * @param {Eris.Message} msg
   * @returns {Promise<void>}
   */
  async updateChatMessage(msg) {
    await knex('thread_messages')
      .where('thread_id', this.id)
      .where('dm_message_id', msg.id)
      .update({
        body: msg.content
      });
  }

  /**
   * @param {String} messageId
   * @returns {Promise<void>}
   */
  async deleteChatMessage(messageId) {
    await knex('thread_messages')
      .where('thread_id', this.id)
      .where('dm_message_id', messageId)
      .delete();
  }

  /**
   * @param {Object} data
   * @returns {Promise<void>}
   */
  async addThreadMessageToDB(data) {
    await knex('thread_messages').insert({
      thread_id: this.id,
      created_at: moment.utc().format('YYYY-MM-DD HH:mm:ss'),
      is_anonymous: 0,
      ...data
    });
  }

  /**
   * @returns {Promise<ThreadMessage[]>}
   */
  async getThreadMessages() {
    const threadMessages = await knex('thread_messages')
      .where('thread_id', this.id)
      .orderBy('created_at', 'ASC')
      .orderBy('id', 'ASC')
      .select();

    return threadMessages.map(row => new ThreadMessage(row));
  }

  /**
   * @returns {Promise<void>}
   */
  async close(silent = false) {
    if (! silent) {
      console.log(`Closing thread ${this.id}`);
      await this.postToThreadChannel('Closing thread...');
    }

    // Update DB status
    await knex('threads')
      .where('id', this.id)
      .update({
        status: THREAD_STATUS.CLOSED
      });

    // Delete channel
    const channel = bot.getChannel(this.channel_id);
    if (channel) {
      console.log(`Deleting channel ${this.channel_id}`);
      await channel.delete('Thread closed');
    }
  }

  /**
   * @returns {Promise<String>}
   */
  getLogUrl() {
    return utils.getSelfUrl(`logs/${this.id}`);
  }
}

module.exports = Thread;

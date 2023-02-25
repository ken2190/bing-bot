import { EmbedBuilder, Message, ThreadChannel, User } from "discord.js";
import EventEmitter from "events";
import chalk from "chalk";

import { GPTGenerationError, GPTGenerationErrorType } from "../error/gpt/generation.js";
import { GenerationOptions, Session, SessionState, StopState } from "./session.js";
import { ConversationManager } from "./manager.js";
import { ChatResponse } from "./types/response.js";
import { GPTAPIError } from "../error/gpt/api.js";
import { Cooldown } from "./utils/cooldown.js";

interface ConversationInitOptions {
	thread?: ThreadChannel;
}

export interface ChatInteraction {
	/* Input message */
	input: string;

	/* Discord message, which triggered the generation */
	trigger: Message;

	/* Generated ChatGPT output */
	output: ChatResponse;

	/* Reply to the trigger on Discord */
	reply: Message | null;

	/* Time the interaction was trigged */
	time: number;
}

export type ChatGeneratedInteraction = ChatInteraction & {
	/* How many tries it took to generate the response */
	tries: number;
}

/* How many milliseconds a conversation stays active without an interaction */
const CONVERSATION_RESET_TIME: number = 6 * 60 * 60 * 1000;

/* How many tries to allow to retry after an error occured duration generation */
const SESSION_ERROR_RETRY_MAX_TRIES: number = 10;

export declare interface Conversation {
	on(event: "done", listener: () => void): this;
	once(event: "done", listener: () => void): this;
}

export class Conversation extends EventEmitter {
	/* Manager in charge of controlling this conversation */
	public readonly manager: ConversationManager;

	/* Discord user, which created the conversation */
	public readonly user: User;

	/* Discord thread, that this conversation is bound to */
	public thread: ThreadChannel | null;

	/* ChatGPT client */
	public session: Session;

	/* Whether the conversation is active & ready */
	public active: boolean;

	/* Whether the client is locked, because it is initializing or shutting down */
	public locked: boolean;

	/* History of ChatGPT prompts & responses */
	public history: ChatInteraction[];

	/* Last interaction with this conversation */
	public updatedAt: number | null;

	/* Timer, to reset the conversation after a specific time of inactivity */
	public timer: NodeJS.Timeout | null;

	/* Cool-down manager */
	public cooldown: Cooldown;

	constructor(manager: ConversationManager, session: Session, user: User) {
		super();
		this.manager = manager;

		this.cooldown = new Cooldown({
			time: 20 * 1000
		});

		this.thread = null;
		this.user = user;

		/* Set up the ChatGPT session. */
		this.session = session;

		/* Set up the conversation data. */
		this.history = [];

		/* Set up some default values. */
		this.updatedAt = null;
		this.active = false;
		this.locked = false;
		this.timer = null;
	}

	public async cachedConversation() {
		const { data } = await this.manager.bot.db.client
			.from("conversations")
			.select("*")
			
			.eq("id", this.id)
			.single();

		return data;
	}

	/**
	 * Try to initialize an existing conversation, using data from the database.
	 * @param thread Thread to use
	 */
	public async from(thread: ThreadChannel): Promise<void> {
		this.thread = thread;

		/* Get information about the existing conversation, including conversation ID and signature. */
		const data = await this.cachedConversation();

		/* If the conversation was not found in the database, throw an error. */
		if (data === null) throw new Error("Conversation does not exist in database");

		/* Change the last update time accordingly & start the inactivity timer. */
		this.updatedAt = data.updatedAt !== null ? Date.parse(data.updatedAt) : Date.now();
		this.applyResetTimer(this.updatedAt);
	}

	/**
	 * Initialize the ChatGPT conversation.
	 * This also gets called after each "reset", in order to maintain the creation time & future data.
	 * 
	 * @param thread New thread to use for the conversation
	 */
	public async init({ thread }: ConversationInitOptions = {}): Promise<void> {
		/* If a new thread was provided, update it. */
		if (thread) this.thread = thread;

        /* Update the conversation entry in the database. */
        await this.manager.bot.db.client
            .from("conversations")

            .upsert({
                createdAt: new Date().toISOString(),
                id: this.user.id,
                active: true,

				channel: this.thread!.id,
				guild: this.thread!.guildId,

				history: {}
            }, {
				onConflict: "id"
			});

		this.applyResetTimer();
		this.active = true;
	}

	/* Get the timestamp, for when the conversation resets due to inactivity. */
	private getResetTime(relative: boolean = false): number | null {
		if (this.history.length === 0) return null;

		/* Time, when the conversation should reset */
		const timeToReset: number = (this.updatedAt ?? 0) + CONVERSATION_RESET_TIME;
		return Math.max(relative ? timeToReset - Date.now() : timeToReset, 0); 
	}

	/**
	 * Apply the reset timer, to reset the conversation after inactivity.
	 * @param updatedAt Time when the last interaction with this conversation occured, optional
	 */
	private applyResetTimer(updatedAt?: number): void {
		/* If a timer already exists, reset it. */
		if (this.timer !== null) clearTimeout(this.timer);
		if (!updatedAt || this.updatedAt === null) this.updatedAt = Date.now();

		this.timer = setTimeout(async () => {
			await this.sendResetMessage(true).catch(() => {});
			await this.reset();
		}, this.getResetTime(true) ?? CONVERSATION_RESET_TIME);
	}

	/**
	 * Send a reset notice to the previous thread channel, to notify the user.
	 */
	public async sendResetMessage(inactive: boolean = false): Promise<void> {
		/* Fetch the starter message of the thread. */
		const starter: Message | null = await this.thread!.fetchStarterMessage();
		if (starter === null) return;

		/* Edit the starter message. */
		await starter.edit({
			embeds: [
				new EmbedBuilder()
					.setDescription(`This conversation has been reset${inactive ? " due to inactivity" : ""}. 😔\n*Start a new thread using \`/conversation\`*.`)
					.setColor("Yellow")
			],

			content: ""
		});
	}

	/**
	 * Reset the Bing conversation, and clear its history & delete the assigned conversation thread.
	 */
	public async reset(soft: boolean = false): Promise<void> {
		/* Reset the conversation data. */
		this.history = [];

		/* Archive the original thread. */
		if (this.thread && !soft) {
			await this.thread.setLocked(true, "Conversation was reset");
			await this.thread.setArchived(true, "Conversation was reset");
		}

		/* Stop the inactivity timer. */
		if (this.timer) clearTimeout(this.timer);

		/* Remove the entry in the database. */
        await this.manager.bot.db.client
            .from("conversations")
			.delete()

			.eq("id", this.user.id);

		/* Unlock the conversation, if a requestion was running meanwhile. */
		this.active = false;
		this.locked = false;
	}

	/**
	 * Call the OpenAI ChatGPT API and generate a response for the given prompt.
	 * @param options Generation options
	 * 
	 * @returns Given chat response
	 */
	public async generate(options: GenerationOptions): Promise<ChatGeneratedInteraction> {
		if (!this.active) throw new Error("Conversation is inactive");
		if (this.locked) throw new Error("Already busy");

		/* Lock the conversation during generation. */
		this.locked = true;

		/* Reset the inactivity timer. */
		if (this.timer) clearTimeout(this.timer);

		/* Amount of attempted tries */
		let tries: number = 0;

		/* ChatGPT response */
		let data: ChatResponse | null = null;

		/**
		 * This loop tries to generate a ChatGPT response N times, until a response gets generated or the retries are exhausted.
		 */
		do {
			/* Try to generate the ChatGPT response. */
			try {
				data = await this.session.generate(options);

			} catch (error) {
				tries++;

				/* If the request failed, due to the current session running out of credit, or being rate-limited, disable the session & retry using a different one. */
				if (
					(error instanceof GPTAPIError && error.options.data.id === "insufficient_quota")
					|| (error instanceof GPTGenerationError && error.options.data.type === GPTGenerationErrorType.SessionUnusable)
				) {
					/* Disable the previous session for now & update the current session, to try again. */
					if (this.session.state !== SessionState.Disabled) await this.session.stop(StopState.Permanent);
					
					/* Find a free session. */
					const free: Session = await this.manager.session();
					this.session = free;

					/* Initialize the newly-assigned session. */
					await this.session.init();

					/* Try again ... */

				} else

				/* Throw through any type of generation error, as they should be handled instantly. */
				if ((error instanceof GPTGenerationError && error.options.data.cause && !(error.options.data.cause instanceof GPTAPIError)) || (error instanceof GPTAPIError && !error.isServerSide())) {
					this.locked = false;
					throw error;

				} else

				if (error instanceof GPTGenerationError && (error.options.data.type === GPTGenerationErrorType.Empty || error.options.data.type === GPTGenerationErrorType.Length)) {
					this.locked = false;
					throw error;

				} else

				/* If all of the retries were exhausted, throw the error. */
				if (tries === SESSION_ERROR_RETRY_MAX_TRIES) {
					this.locked = false;

					if (error instanceof GPTGenerationError || error instanceof GPTAPIError) {
						throw error;
					} else {
						throw new GPTGenerationError({
							type: GPTGenerationErrorType.Other,
							cause: error as Error
						});
					}

				} else {
					/* Display a notice message on Discord. */
					options.onProgress({
						id: "",
						attachments: [],
						images: [],
						sources: [],
						suggestions: [],
						type: "Notice",
						text: `Something went wrong while processing your message, retrying`
					});

					this.manager.bot.logger.warn(`Failed to generate a response for ${chalk.bold(options.trigger.author.tag)}, retrying... -> ${chalk.italic((error as Error).toString())} [${chalk.bold(tries)}/${chalk.bold(SESSION_ERROR_RETRY_MAX_TRIES)}]`);
					await new Promise(resolve => setTimeout(resolve, 5000));
				}
			}
		} while (tries < SESSION_ERROR_RETRY_MAX_TRIES && data === null && this.locked);

		/* Unlock the conversation after generation has finished. */
		this.locked = false;
		this.emit("done");

		/* If the data still turned out `null` somehow, ...! */
		if (data === null) throw new Error("What.");

		const output: ChatInteraction = {
			input: options.prompt,
			output: data,

			trigger: options.trigger,
			reply: null,

			time: Date.now()
		};

		/* Add the response to the history. */
		this.history.push(output);

		/* Set up the inactivity timer again, and use the creation time of the newly-generated message. */
		this.applyResetTimer();

		/* Conversation history size stored in the database */
		const cachedCount = await this.count();

		/* Also update the last-updated time and message count in the database for this conversation. */
		this.manager.bot.db.client
			.from("conversations")
			.update({
				updatedAt: new Date().toISOString(),
				count: cachedCount !== -1 ? cachedCount + 1 : undefined 
			})
			.eq("id", this.id);

		/* Activate the cool-down. */
		this.cooldown.use();

		return {
			...output,
			tries
		};
	}

	/* Previous message sent in the conversation */
	public get previous(): ChatInteraction | null {
		if (this.history.length === 0) return null;
		return this.history[this.history.length - 1];
	}

	/**
	 * Calculate how many messages are in this chat's history.
	 * @returns Amount of messages in this chat history
	 */
	public async count(): Promise<number> {
		const data = await this.cachedConversation();
		return data !== null ? data.count : -1;
	}

	/* ID of the conversation */
	public get id(): string {
		return this.user.id;
	}
}
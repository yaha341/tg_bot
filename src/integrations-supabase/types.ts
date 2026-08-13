export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      order_counters: {
        Row: {
          bot_id: string
          last_no: number
        }
        Insert: {
          bot_id: string
          last_no?: number
        }
        Update: {
          bot_id?: string
          last_no?: number
        }
        Relationships: [
          {
            foreignKeyName: "order_counters_bot_id_fkey"
            columns: ["bot_id"]
            isOneToOne: false
            referencedRelation: "bots"
            referencedColumns: ["id"]
          },
        ]
      }
      broadcast_recipients: {
        Row: {
          id: string
          broadcast_id: string
          telegram_id: number
          status: string
          error_message: string | null
          sent_at: string | null
          bot_id: string | null
        }
        Insert: {
          id?: string
          broadcast_id: string
          telegram_id: number
          status?: string
          error_message?: string | null
          sent_at?: string | null
          bot_id?: string | null
        }
        Update: {
          id?: string
          broadcast_id?: string
          telegram_id?: number
          status?: string
          error_message?: string | null
          sent_at?: string | null
          bot_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "broadcast_recipients_broadcast_id_fkey"
            columns: ["broadcast_id"]
            isOneToOne: false
            referencedRelation: "broadcasts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "broadcast_recipients_bot_id_fkey"
            columns: ["bot_id"]
            isOneToOne: false
            referencedRelation: "bots"
            referencedColumns: ["id"]
          },
        ]
      }
      bots: {
        Row: {
          id: string
          bot_token: string
          bot_name: string
          owner_id: string
          status: string | null
          modules: Json | null
          settings: Json | null
          subscription_plan: string | null
          subscription_expires_at: string | null
          created_at: string | null
          updated_at: string | null
        }
        Insert: {
          id?: string
          bot_token: string
          bot_name: string
          owner_id: string
          status?: string | null
          modules?: Json | null
          settings?: Json | null
          subscription_plan?: string | null
          subscription_expires_at?: string | null
          created_at?: string | null
          updated_at?: string | null
        }
        Update: {
          id?: string
          bot_token?: string
          bot_name?: string
          owner_id?: string
          status?: string | null
          modules?: Json | null
          settings?: Json | null
          subscription_plan?: string | null
          subscription_expires_at?: string | null
          created_at?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      zernio_logs: {
        Row: {
          id: string
          event_id: string | null
          event_type: string
          status: string
          payload: Json
          error_message: string | null
          created_at: string
          bot_id: string | null
        }
        Insert: {
          id?: string
          event_id?: string | null
          event_type: string
          status?: string
          payload?: Json
          error_message?: string | null
          created_at?: string
          bot_id?: string | null
        }
        Update: {
          id?: string
          event_id?: string | null
          event_type?: string
          status?: string
          payload?: Json
          error_message?: string | null
          created_at?: string
          bot_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "zernio_logs_bot_id_fkey"
            columns: ["bot_id"]
            isOneToOne: false
            referencedRelation: "bots"
            referencedColumns: ["id"]
          },
        ]
      }
      vip_member_profiles: {
        Row: {
          bot_id: string
          telegram_id: number
          username: string | null
          first_name: string | null
          last_name: string | null
          assigned_tariff_id: string | null
          assigned_at: string
          assigned_source: string
        }
        Insert: {
          bot_id: string
          telegram_id: number
          username?: string | null
          first_name?: string | null
          last_name?: string | null
          assigned_tariff_id?: string | null
          assigned_at?: string
          assigned_source?: string
        }
        Update: {
          bot_id?: string
          telegram_id?: number
          username?: string | null
          first_name?: string | null
          last_name?: string | null
          assigned_tariff_id?: string | null
          assigned_at?: string
          assigned_source?: string
        }
        Relationships: [
          {
            foreignKeyName: "vip_member_profiles_bot_id_fkey"
            columns: ["bot_id"]
            isOneToOne: false
            referencedRelation: "bots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vip_member_profiles_assigned_tariff_id_fkey"
            columns: ["assigned_tariff_id"]
            isOneToOne: false
            referencedRelation: "vip_tariffs"
            referencedColumns: ["id"]
          },
        ]
      }
      vip_tariffs: {
        Row: {
          id: string
          bot_id: string
          name: string
          description: string
          price: number
          currency: string
          duration_days: number
          is_active: boolean
          sort_order: number
          created_at: string
          duration_minutes: number | null
          is_entry: boolean
          is_public: boolean
        }
        Insert: {
          id?: string
          bot_id: string
          name: string
          description?: string
          price?: number
          currency?: string
          duration_days?: number
          is_active?: boolean
          sort_order?: number
          created_at?: string
          duration_minutes?: number | null
          is_entry?: boolean
          is_public?: boolean
        }
        Update: {
          id?: string
          bot_id?: string
          name?: string
          description?: string
          price?: number
          currency?: string
          duration_days?: number
          is_active?: boolean
          sort_order?: number
          created_at?: string
          duration_minutes?: number | null
          is_entry?: boolean
          is_public?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "vip_tariffs_bot_id_fkey"
            columns: ["bot_id"]
            isOneToOne: false
            referencedRelation: "bots"
            referencedColumns: ["id"]
          },
        ]
      }
      blocked_users: {
        Row: {
          bot_id: string
          telegram_id: number
          username: string | null
          first_name: string | null
          reason: string | null
          blocked_at: string
        }
        Insert: {
          bot_id: string
          telegram_id: number
          username?: string | null
          first_name?: string | null
          reason?: string | null
          blocked_at?: string
        }
        Update: {
          bot_id?: string
          telegram_id?: number
          username?: string | null
          first_name?: string | null
          reason?: string | null
          blocked_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "blocked_users_bot_id_fkey"
            columns: ["bot_id"]
            isOneToOne: false
            referencedRelation: "bots"
            referencedColumns: ["id"]
          },
        ]
      }
      broadcasts: {
        Row: {
          id: string
          status: string
          message_text: string
          photo_paths: Json
          product_ids: Json
          show_catalog: boolean
          audience_type: string
          audience_filter: Json
          total_count: number
          sent_count: number
          failed_count: number
          blocked_count: number
          created_at: string
          started_at: string | null
          completed_at: string | null
          bot_id: string | null
        }
        Insert: {
          id?: string
          status?: string
          message_text: string
          photo_paths?: Json
          product_ids?: Json
          show_catalog?: boolean
          audience_type?: string
          audience_filter?: Json
          total_count?: number
          sent_count?: number
          failed_count?: number
          blocked_count?: number
          created_at?: string
          started_at?: string | null
          completed_at?: string | null
          bot_id?: string | null
        }
        Update: {
          id?: string
          status?: string
          message_text?: string
          photo_paths?: Json
          product_ids?: Json
          show_catalog?: boolean
          audience_type?: string
          audience_filter?: Json
          total_count?: number
          sent_count?: number
          failed_count?: number
          blocked_count?: number
          created_at?: string
          started_at?: string | null
          completed_at?: string | null
          bot_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "broadcasts_bot_id_fkey"
            columns: ["bot_id"]
            isOneToOne: false
            referencedRelation: "bots"
            referencedColumns: ["id"]
          },
        ]
      }
      vip_subscriptions: {
        Row: {
          id: string
          bot_id: string
          telegram_id: number
          username: string | null
          first_name: string | null
          last_name: string | null
          tariff_id: string | null
          status: string
          payment_proof_path: string | null
          group_invite_link: string | null
          started_at: string | null
          expires_at: string
          imported: boolean
          admin_note: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          bot_id: string
          telegram_id: number
          username?: string | null
          first_name?: string | null
          last_name?: string | null
          tariff_id?: string | null
          status?: string
          payment_proof_path?: string | null
          group_invite_link?: string | null
          started_at?: string | null
          expires_at: string
          imported?: boolean
          admin_note?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          bot_id?: string
          telegram_id?: number
          username?: string | null
          first_name?: string | null
          last_name?: string | null
          tariff_id?: string | null
          status?: string
          payment_proof_path?: string | null
          group_invite_link?: string | null
          started_at?: string | null
          expires_at?: string
          imported?: boolean
          admin_note?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "vip_subscriptions_bot_id_fkey"
            columns: ["bot_id"]
            isOneToOne: false
            referencedRelation: "bots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vip_subscriptions_tariff_id_fkey"
            columns: ["tariff_id"]
            isOneToOne: false
            referencedRelation: "vip_tariffs"
            referencedColumns: ["id"]
          },
        ]
      }
      product_material_files: {
        Row: {
          id: string
          bot_id: string
          product_id: string
          language: string
          file_path: string
          file_name: string | null
          sort_order: number
        }
        Insert: {
          id?: string
          bot_id: string
          product_id: string
          language?: string
          file_path: string
          file_name?: string | null
          sort_order?: number
        }
        Update: {
          id?: string
          bot_id?: string
          product_id?: string
          language?: string
          file_path?: string
          file_name?: string | null
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "product_material_files_bot_id_fkey"
            columns: ["bot_id"]
            isOneToOne: false
            referencedRelation: "bots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_material_files_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      zernio_automations: {
        Row: {
          id: string
          title: string
          keywords: string[]
          reply_text: string
          dm_text: string | null
          post_id: string | null
          is_active: boolean
          trigger_count: number
          created_at: string
          updated_at: string
          bot_id: string | null
        }
        Insert: {
          id?: string
          title: string
          keywords: string[]
          reply_text: string
          dm_text?: string | null
          post_id?: string | null
          is_active?: boolean
          trigger_count?: number
          created_at?: string
          updated_at?: string
          bot_id?: string | null
        }
        Update: {
          id?: string
          title?: string
          keywords?: string[]
          reply_text?: string
          dm_text?: string | null
          post_id?: string | null
          is_active?: boolean
          trigger_count?: number
          created_at?: string
          updated_at?: string
          bot_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "zernio_automations_bot_id_fkey"
            columns: ["bot_id"]
            isOneToOne: false
            referencedRelation: "bots"
            referencedColumns: ["id"]
          },
        ]
      }
      app_settings: {
        Row: {
          bot_id: string | null
          key: string
          updated_at: string
          value: string | null
        }
        Insert: {
          bot_id?: string | null
          key: string
          updated_at?: string
          value?: string | null
        }
        Update: {
          bot_id?: string | null
          key?: string
          updated_at?: string
          value?: string | null
        }
        Relationships: []
      }
      bot_users: {
        Row: {
          bot_id: string | null
          last_auto_dm_at: string | null
          opt_out: boolean
          zernio_account_id: string | null
          zernio_conversation_id: string | null
          user_key: string
          platform: string
          contact_phone: string | null
          created_at: string
          first_name: string | null
          language_code: string | null
          last_name: string | null
          state: Json
          telegram_id: number
          updated_at: string
          username: string | null
        }
        Insert: {
          bot_id?: string | null
          last_auto_dm_at?: string | null
          opt_out?: boolean
          zernio_account_id?: string | null
          zernio_conversation_id?: string | null
          user_key: string
          platform?: string
          contact_phone?: string | null
          created_at?: string
          first_name?: string | null
          language_code?: string | null
          last_name?: string | null
          state?: Json
          telegram_id: number
          updated_at?: string
          username?: string | null
        }
        Update: {
          bot_id?: string | null
          last_auto_dm_at?: string | null
          opt_out?: boolean
          zernio_account_id?: string | null
          zernio_conversation_id?: string | null
          user_key?: string
          platform?: string
          contact_phone?: string | null
          created_at?: string
          first_name?: string | null
          language_code?: string | null
          last_name?: string | null
          state?: Json
          telegram_id?: number
          updated_at?: string
          username?: string | null
        }
        Relationships: []
      }
      cart_items: {
        Row: {
          bot_id: string | null
          user_key: string | null
          created_at: string
          id: string
          product_id: string
          quantity: number
          telegram_id: number
        }
        Insert: {
          bot_id?: string | null
          user_key?: string | null
          created_at?: string
          id?: string
          product_id: string
          quantity?: number
          telegram_id: number
        }
        Update: {
          bot_id?: string | null
          user_key?: string | null
          created_at?: string
          id?: string
          product_id?: string
          quantity?: number
          telegram_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "cart_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cart_items_telegram_id_fkey"
            columns: ["telegram_id"]
            isOneToOne: false
            referencedRelation: "bot_users"
            referencedColumns: ["telegram_id"]
          },
        ]
      }
      categories: {
        Row: {
          bot_id: string | null
          created_at: string
          id: string
          is_visible: boolean
          name: string
          parent_id: string | null
          sort_order: number
        }
        Insert: {
          bot_id?: string | null
          created_at?: string
          id?: string
          is_visible?: boolean
          name: string
          parent_id?: string | null
          sort_order?: number
        }
        Update: {
          bot_id?: string | null
          created_at?: string
          id?: string
          is_visible?: boolean
          name?: string
          parent_id?: string | null
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "categories_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
        ]
      }
      order_items: {
        Row: {
          material_files_kz_snapshot: Json
          material_files_snapshot: Json
          file_url_kz_snapshot: string | null
          file_url_snapshot: string | null
          bot_id: string | null
          file_name_kz_snapshot: string | null
          file_path_kz_snapshot: string | null
          delivered_language: string | null
          file_name_snapshot: string | null
          file_path_snapshot: string | null
          id: string
          name_snapshot: string
          order_id: number
          price_snapshot: number
          product_id: string | null
          quantity: number
        }
        Insert: {
          material_files_kz_snapshot?: Json
          material_files_snapshot?: Json
          file_url_kz_snapshot?: string | null
          file_url_snapshot?: string | null
          bot_id?: string | null
          file_name_kz_snapshot?: string | null
          file_path_kz_snapshot?: string | null
          delivered_language?: string | null
          file_name_snapshot?: string | null
          file_path_snapshot?: string | null
          id?: string
          name_snapshot: string
          order_id: number
          price_snapshot: number
          product_id?: string | null
          quantity?: number
        }
        Update: {
          material_files_kz_snapshot?: Json
          material_files_snapshot?: Json
          file_url_kz_snapshot?: string | null
          file_url_snapshot?: string | null
          bot_id?: string | null
          file_name_kz_snapshot?: string | null
          file_path_kz_snapshot?: string | null
          delivered_language?: string | null
          file_name_snapshot?: string | null
          file_path_snapshot?: string | null
          id?: string
          name_snapshot?: string
          order_id?: number
          price_snapshot?: number
          product_id?: string | null
          quantity?: number
        }
        Relationships: [
          {
            foreignKeyName: "order_items_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          order_no: number
          bot_id: string | null
          zernio_conversation_id: string | null
          user_key: string | null
          platform: string
          delivery_index: number
          admin_note: string | null
          contact: string | null
          country_code: string | null
          country_name: string | null
          created_at: string
          currency: string
          display_name: string | null
          id: number
          payment_proof_path: string | null
          status: string
          telegram_id: number
          total: number
          updated_at: string
          username: string | null
        }
        Insert: {
          order_no?: number
          bot_id?: string | null
          zernio_conversation_id?: string | null
          user_key?: string | null
          platform?: string
          delivery_index?: number
          admin_note?: string | null
          contact?: string | null
          country_code?: string | null
          country_name?: string | null
          created_at?: string
          currency?: string
          display_name?: string | null
          id?: number
          payment_proof_path?: string | null
          status?: string
          telegram_id: number
          total?: number
          updated_at?: string
          username?: string | null
        }
        Update: {
          order_no?: number
          bot_id?: string | null
          zernio_conversation_id?: string | null
          user_key?: string | null
          platform?: string
          delivery_index?: number
          admin_note?: string | null
          contact?: string | null
          country_code?: string | null
          country_name?: string | null
          created_at?: string
          currency?: string
          display_name?: string | null
          id?: number
          payment_proof_path?: string | null
          status?: string
          telegram_id?: number
          total?: number
          updated_at?: string
          username?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "orders_telegram_id_fkey"
            columns: ["telegram_id"]
            isOneToOne: false
            referencedRelation: "bot_users"
            referencedColumns: ["telegram_id"]
          },
        ]
      }
      payment_methods: {
        Row: {
          qr_code_path: string | null
          bot_id: string | null
          country_code: string
          country_name: string
          created_at: string
          currency: string
          id: string
          instructions: string
          is_active: boolean
          sort_order: number
        }
        Insert: {
          qr_code_path?: string | null
          bot_id?: string | null
          country_code: string
          country_name: string
          created_at?: string
          currency?: string
          id?: string
          instructions: string
          is_active?: boolean
          sort_order?: number
        }
        Update: {
          qr_code_path?: string | null
          bot_id?: string | null
          country_code?: string
          country_name?: string
          created_at?: string
          currency?: string
          id?: string
          instructions?: string
          is_active?: boolean
          sort_order?: number
        }
        Relationships: []
      }
      ig_keywords: {
        Row: {
          bot_id: string | null
          comment_reply_text: string | null
          comments_post_id: string | null
          created_at: string
          dm_file_kind: string | null
          dm_file_name: string | null
          dm_file_path: string | null
          id: string
          is_active: boolean
          keyword: string
          post_id: string | null
          post_note: string | null
          post_shortcode: string | null
          reply_text: string
          updated_at: string
        }
        Insert: {
          bot_id?: string | null
          comment_reply_text?: string | null
          comments_post_id?: string | null
          created_at?: string
          dm_file_kind?: string | null
          dm_file_name?: string | null
          dm_file_path?: string | null
          id?: string
          is_active?: boolean
          keyword: string
          post_id?: string | null
          post_note?: string | null
          post_shortcode?: string | null
          reply_text: string
          updated_at?: string
        }
        Update: {
          bot_id?: string | null
          comment_reply_text?: string | null
          comments_post_id?: string | null
          created_at?: string
          dm_file_kind?: string | null
          dm_file_name?: string | null
          dm_file_path?: string | null
          id?: string
          is_active?: boolean
          keyword?: string
          post_id?: string | null
          post_note?: string | null
          post_shortcode?: string | null
          reply_text?: string
          updated_at?: string
        }
        Relationships: []
      }
      ig_poll_runs: {
        Row: {
          bot_id: string | null
          comments_scanned: number
          errors: string | null
          finished_at: string | null
          id: string
          matched: number
          note: string | null
          posts_polled: number
          rules_count: number
          sent: number
          skipped: number
          started_at: string
          status: string
        }
        Insert: {
          bot_id?: string | null
          comments_scanned?: number
          errors?: string | null
          finished_at?: string | null
          id?: string
          matched?: number
          note?: string | null
          posts_polled?: number
          rules_count?: number
          sent?: number
          skipped?: number
          started_at?: string
          status?: string
        }
        Update: {
          bot_id?: string | null
          comments_scanned?: number
          errors?: string | null
          finished_at?: string | null
          id?: string
          matched?: number
          note?: string | null
          posts_polled?: number
          rules_count?: number
          sent?: number
          skipped?: number
          started_at?: string
          status?: string
        }
        Relationships: []
      }
      ig_watched_posts: {
        Row: {
          bot_id: string | null
          caption_snapshot: string | null
          comments_post_id: string | null
          created_at: string
          id: string
          is_active: boolean
          post_display_id: string | null
          post_id: string
          post_shortcode: string | null
          updated_at: string
        }
        Insert: {
          bot_id?: string | null
          caption_snapshot?: string | null
          comments_post_id?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          post_display_id?: string | null
          post_id: string
          post_shortcode?: string | null
          updated_at?: string
        }
        Update: {
          bot_id?: string | null
          caption_snapshot?: string | null
          comments_post_id?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          post_display_id?: string | null
          post_id?: string
          post_shortcode?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      ig_exclusions: {
        Row: {
          bot_id: string | null
          created_at: string
          id: string
          provider_user_id: string | null
          reason: string | null
          username: string | null
        }
        Insert: {
          bot_id?: string | null
          created_at?: string
          id?: string
          provider_user_id?: string | null
          reason?: string | null
          username?: string | null
        }
        Update: {
          bot_id?: string | null
          created_at?: string
          id?: string
          provider_user_id?: string | null
          reason?: string | null
          username?: string | null
        }
        Relationships: []
      }
      ig_comment_actions: {
        Row: {
          bot_id: string | null
          attempt_no: number
          comment_id: string
          comment_text: string | null
          created_at: string
          debug_info: Json | null
          error_message: string | null
          id: string
          keyword_id: string | null
          lead_id: string | null
          post_id: string
          provider_user_id: string | null
          status: string
          username: string | null
        }
        Insert: {
          bot_id?: string | null
          attempt_no?: number
          comment_id: string
          comment_text?: string | null
          created_at?: string
          debug_info?: Json | null
          error_message?: string | null
          id?: string
          keyword_id?: string | null
          lead_id?: string | null
          post_id: string
          provider_user_id?: string | null
          status?: string
          username?: string | null
        }
        Update: {
          bot_id?: string | null
          attempt_no?: number
          comment_id?: string
          comment_text?: string | null
          created_at?: string
          debug_info?: Json | null
          error_message?: string | null
          id?: string
          keyword_id?: string | null
          lead_id?: string | null
          post_id?: string
          provider_user_id?: string | null
          status?: string
          username?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ig_comment_actions_keyword_id_fkey"
            columns: ["keyword_id"]
            isOneToOne: false
            referencedRelation: "ig_keywords"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ig_comment_actions_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "ig_post_leads"
            referencedColumns: ["id"]
          },
        ]
      }
      ig_post_leads: {
        Row: {
          bot_id: string | null
          author_profile_id: string | null
          closed_reason: string | null
          comment_replied_at: string | null
          created_at: string
          dm_attempts: number
          dm_recipient_id: string | null
          dm_sent_at: string | null
          dm_status: string
          first_comment_id: string | null
          first_dm_attempt_at: string | null
          id: string
          is_active: boolean
          keyword_id: string | null
          last_comment_id: string | null
          last_comment_text: string | null
          last_error: string | null
          next_retry_at: string | null
          post_id: string
          provider_user_id: string
          retry_until_at: string | null
          unipile_comment_id: string | null
          updated_at: string
          username: string | null
        }
        Insert: {
          bot_id?: string | null
          author_profile_id?: string | null
          closed_reason?: string | null
          comment_replied_at?: string | null
          created_at?: string
          dm_attempts?: number
          dm_recipient_id?: string | null
          dm_sent_at?: string | null
          dm_status?: string
          first_comment_id?: string | null
          first_dm_attempt_at?: string | null
          id?: string
          is_active?: boolean
          keyword_id?: string | null
          last_comment_id?: string | null
          last_comment_text?: string | null
          last_error?: string | null
          next_retry_at?: string | null
          post_id: string
          provider_user_id: string
          retry_until_at?: string | null
          unipile_comment_id?: string | null
          updated_at?: string
          username?: string | null
        }
        Update: {
          bot_id?: string | null
          author_profile_id?: string | null
          closed_reason?: string | null
          comment_replied_at?: string | null
          created_at?: string
          dm_attempts?: number
          dm_recipient_id?: string | null
          dm_sent_at?: string | null
          dm_status?: string
          first_comment_id?: string | null
          first_dm_attempt_at?: string | null
          id?: string
          is_active?: boolean
          keyword_id?: string | null
          last_comment_id?: string | null
          last_comment_text?: string | null
          last_error?: string | null
          next_retry_at?: string | null
          post_id?: string
          provider_user_id?: string
          retry_until_at?: string | null
          unipile_comment_id?: string | null
          updated_at?: string
          username?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ig_post_leads_keyword_id_fkey"
            columns: ["keyword_id"]
            isOneToOne: false
            referencedRelation: "ig_keywords"
            referencedColumns: ["id"]
          },
        ]
      }
      product_images: {
        Row: {
          bot_id: string | null
          created_at: string
          id: string
          image_path: string
          product_id: string
          sort_order: number
        }
        Insert: {
          bot_id?: string | null
          created_at?: string
          id?: string
          image_path: string
          product_id: string
          sort_order?: number
        }
        Update: {
          bot_id?: string | null
          created_at?: string
          id?: string
          image_path?: string
          product_id?: string
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "product_images_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      products: {
        Row: {
          file_url_kz: string | null
          file_url: string | null
          bot_id: string | null
          file_name_kz: string | null
          file_path_kz: string | null
          category_ids: Json
          country_prices: Json
          category_id: string | null
          created_at: string
          currency: string
          description: string
          file_name: string | null
          file_path: string | null
          id: string
          is_active: boolean
          keywords: string
          name: string
          price: number
          sort_order: number
        }
        Insert: {
          file_url_kz?: string | null
          file_url?: string | null
          bot_id?: string | null
          file_name_kz?: string | null
          file_path_kz?: string | null
          category_ids: Json
          country_prices: Json
          category_id?: string | null
          created_at?: string
          currency?: string
          description?: string
          file_name?: string | null
          file_path?: string | null
          id?: string
          is_active?: boolean
          keywords?: string
          name: string
          price?: number
          sort_order?: number
        }
        Update: {
          file_url_kz?: string | null
          file_url?: string | null
          bot_id?: string | null
          file_name_kz?: string | null
          file_path_kz?: string | null
          category_ids?: Json
          country_prices?: Json
          category_id?: string | null
          created_at?: string
          currency?: string
          description?: string
          file_name?: string | null
          file_path?: string | null
          id?: string
          is_active?: boolean
          keywords?: string
          name?: string
          price?: number
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "products_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const

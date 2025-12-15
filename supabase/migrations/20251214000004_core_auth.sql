-- Create profiles table (extends auth.users)
CREATE TABLE profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    full_name TEXT,
    avatar_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Profiles Policies
CREATE POLICY "Users can view their own profile" 
    ON profiles FOR SELECT 
    USING (auth.uid() = id);

CREATE POLICY "Users can update their own profile" 
    ON profiles FOR UPDATE 
    USING (auth.uid() = id);

-- Create organization_members table
CREATE TABLE organization_members (
    organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    profile_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('admin', 'coach', 'player', 'parent', 'staff')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (organization_id, profile_id)
);

-- Enable RLS
ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;

-- Organization Members Policies
CREATE POLICY "Users can view members of their organizations"
    ON organization_members FOR SELECT
    USING (
        auth.uid() IN (
            SELECT profile_id 
            FROM organization_members om 
            WHERE om.organization_id = organization_members.organization_id
        )
    );

-- Helper function to check if user is admin of org
CREATE OR REPLACE FUNCTION is_org_admin(org_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 
        FROM organization_members 
        WHERE organization_id = org_id 
        AND profile_id = auth.uid() 
        AND role = 'admin'
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to create profile on signup (optional, usually handled by Auth Hook)
-- For now, we assume application logic creates it or an Edge Function trigger.
